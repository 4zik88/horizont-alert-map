/**
 * Pure scheduling decisions, separated from the loop so they can be tested without a
 * clock or a network. Inject `rng` to make jitter deterministic in tests.
 */

export interface DelayOptions {
  baseMs: number;
  jitterPct: number;
  maxBackoffMs: number;
}

/**
 * Delay before the next poll. Exponential in the number of consecutive failures,
 * capped, and always jittered so three channels never re-synchronise into a burst.
 */
export function nextDelay(
  failures: number,
  opts: DelayOptions,
  rng: () => number = Math.random,
): number {
  const exponent = Math.min(failures, 20); // guards against 2**huge -> Infinity
  const backoff = failures > 0 ? opts.baseMs * 2 ** exponent : opts.baseMs;
  const capped = Math.min(backoff, opts.maxBackoffMs);
  const jitter = 1 - opts.jitterPct + rng() * opts.jitterPct * 2;
  return Math.round(capped * jitter);
}

/**
 * Whether there is a gap between what we have and what the page shows.
 *
 * `lastSeenId === 0` means a cold start: take the visible page and move on, rather
 * than walking the channel's entire history.
 */
export function needsGapFill(lastSeenId: number, minIdOnPage: number): boolean {
  if (lastSeenId <= 0) return false;
  return minIdOnPage > lastSeenId + 1;
}

/**
 * Whether a gap-fill page made progress.
 *
 * Termination is "no id newer than the cursor", never id contiguity: deleted posts
 * leave permanent holes in the id sequence (verified — sectorv666 has no 58352), and
 * a contiguity-based loop would chase them forever.
 */
export function gapFillAdvanced(cursor: number, maxIdOnPage: number | null): boolean {
  return maxIdOnPage !== null && maxIdOnPage > cursor;
}

/**
 * Failures 1-4 are warnings; the 5th is an error, and after that only every 10th, so
 * a long Telegram outage does not produce thousands of identical error lines.
 */
export function failureLogLevel(failures: number): 'warn' | 'error' | 'debug' {
  if (failures < 5) return 'warn';
  if (failures === 5 || failures % 10 === 0) return 'error';
  return 'debug';
}
