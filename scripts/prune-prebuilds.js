#!/usr/bin/env node
// Strips prebuilt native bindings for platforms/archs other than the target, before packaging a platform-specific vsix.
const fs = require('fs');
const path = require('path');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/prune-prebuilds.js <vsce-target>');
  process.exit(1);
}


function pruneDir(prebuildsDir, matches) {
  let kept = 0;
  for (const entry of fs.readdirSync(prebuildsDir)) {
    if (matches(entry)) {
      kept++;
      continue;
    }
    fs.rmSync(path.join(prebuildsDir, entry), { recursive: true, force: true });
  }
  return kept;
}

// node-hid: one subdirectory per platform+arch, e.g. prebuilds/HID-win32-x64/
const hidKept = pruneDir(
  path.join(__dirname, '..', 'node_modules', 'node-hid', 'prebuilds'),
  (entry) => entry.endsWith(target)
);

// better-sqlite3: one file per platform+arch, e.g. prebuilds/win32-x64.node
const sqliteKept = pruneDir(
  path.join(__dirname, '..', 'node_modules', 'better-sqlite3', 'prebuilds'),
  (entry) => entry === `${target}.node`
);

if (hidKept === 0 || sqliteKept === 0) {
  console.error(
    `No prebuilds matched target "${target}" (node-hid: ${hidKept}, better-sqlite3: ${sqliteKept}). ` +
      'Aborting so the build doesn\'t silently ship a broken vsix.'
  );
  process.exit(1);
}

console.log(`Pruned prebuilds for target "${target}": node-hid kept ${hidKept}, better-sqlite3 kept ${sqliteKept}.`);
