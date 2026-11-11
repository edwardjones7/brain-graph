/**
 * One run at a time. Every Claude run reads and writes the vault and touches git, so
 * serializing everything is the simplest way to never corrupt either. Chat, scheduled jobs and
 * wrap-ups all go through here.
 */
let tail: Promise<unknown> = Promise.resolve();
let depth = 0;

export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  depth++;
  // A failed run must not stall the queue, so the next one runs either way.
  const run = tail.then(fn, fn);
  tail = run.catch(() => {}).finally(() => depth--);
  return run;
}

export function queueDepth(): number {
  return depth;
}
