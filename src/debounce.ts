/** Generic debouncer for fast steno stuff */
export interface Debouncer {
  /** Schedules `run`, unless a run is already pending. */
  schedule(): void;
  /** If a run is pending, cancels its timer and executes it immediately. */
  flush(): Promise<void>;
  /** Cancels any pending run without executing it. */
  cancel(): void;
}

export function createDebouncer(delayMs: number, run: () => Promise<void>): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    schedule(): void {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void run();
      }, delayMs);
    },
    async flush(): Promise<void> {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
      await run();
    },
    cancel(): void {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
