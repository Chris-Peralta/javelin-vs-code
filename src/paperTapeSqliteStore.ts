import type Database from "better-sqlite3";
import type { PaperTapeEntry } from "./paperTapeRecorder";
import type { PaperTapeWordAnchor } from "./paperTapeWordTracker";
import { entryIdentity } from "./paperTapeWordGrouping";
import type { PaperTapeStore } from "./paperTapeStore";

// Synchronous and thread-blocking by design; bounded to ~150ms worst case.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Retries schema setup on SQLITE_BUSY */
function withBusyRetry<T>(fn: () => T, attempts = 5): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      const busy = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "SQLITE_BUSY";
      if (!busy || attempt === attempts - 1) throw err;
      sleepSync(15 * (attempt + 1));
    }
  }
}

/** SQLite-backed PaperTapeStore - WAL mode lets multiple windows write concurrently without a read-merge-write cycle. */
export class SqlitePaperTapeStore implements PaperTapeStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    // Required lazily so a missing/incompatible native binary throws here, inside openPaperTapeStore's try/catch, instead of crashing extension activation at module-load time.
    const openDatabase = require("better-sqlite3") as typeof Database;
    // timeout must be set at construction, not via a `busy_timeout` pragma after open, so the first statement (the journal_mode pragma below) already has a busy handler to retry with.
    this.db = new openDatabase(dbPath, { timeout: 5000 });
    withBusyRetry(() => {
      this.db.pragma("journal_mode = WAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          identity TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS entries_timestamp ON entries(timestamp);
        CREATE TABLE IF NOT EXISTS anchors (
          wordId TEXT PRIMARY KEY,
          data TEXT NOT NULL
        );
      `);
    });
  }

  loadEntries(): PaperTapeEntry[] {
    // Same (timestamp, identity) order as loadEntriesBefore, so a cross-window timestamp tie sorts consistently regardless of which method a caller uses.
    const rows = this.db.prepare("SELECT data FROM entries ORDER BY timestamp ASC, identity ASC").all() as {
      data: string;
    }[];
    return rows.map((row) => JSON.parse(row.data) as PaperTapeEntry);
  }

  loadEntriesBefore(cursor: PaperTapeEntry | undefined, limit: number): PaperTapeEntry[] {
    // Ordered by (timestamp, identity) rather than timestamp alone, so same-millisecond entries can't skip or duplicate at the page boundary.
    const rows = cursor
      ? (this.db
          .prepare(
            "SELECT data FROM entries WHERE (timestamp, identity) < (?, ?) ORDER BY timestamp DESC, identity DESC LIMIT ?"
          )
          .all(cursor.timestamp, entryIdentity(cursor), limit) as { data: string }[])
      : (this.db
          .prepare("SELECT data FROM entries ORDER BY timestamp DESC, identity DESC LIMIT ?")
          .all(limit) as { data: string }[]);
    return rows.map((row) => JSON.parse(row.data) as PaperTapeEntry).reverse();
  }

  appendEntry(entry: PaperTapeEntry): void {
    // Same identity as WordGrouper's wordId derivation, so a retried/replayed append collides with itself (INSERT OR REPLACE) instead of duplicating.
    this.db
      .prepare("INSERT OR REPLACE INTO entries (identity, timestamp, data) VALUES (?, ?, ?)")
      .run(entryIdentity(entry), entry.timestamp, JSON.stringify(entry));
  }

  appendEntries(entries: readonly PaperTapeEntry[]): void {
    const insert = this.db.prepare("INSERT OR REPLACE INTO entries (identity, timestamp, data) VALUES (?, ?, ?)");
    const insertMany = this.db.transaction((batch: readonly PaperTapeEntry[]) => {
      for (const entry of batch) insert.run(entryIdentity(entry), entry.timestamp, JSON.stringify(entry));
    });
    insertMany(entries);
  }

  clearEntries(): void {
    this.db.exec("DELETE FROM entries");
  }

  loadAnchors(): PaperTapeWordAnchor[] {
    const rows = this.db.prepare("SELECT data FROM anchors").all() as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as PaperTapeWordAnchor);
  }

  upsertAnchor(anchor: PaperTapeWordAnchor): void {
    this.db
      .prepare("INSERT OR REPLACE INTO anchors (wordId, data) VALUES (?, ?)")
      .run(anchor.wordId, JSON.stringify(anchor));
  }

  clearAnchors(): void {
    this.db.exec("DELETE FROM anchors");
  }

  close(): void {
    this.db.close();
  }
}
