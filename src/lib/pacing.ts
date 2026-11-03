export const BASE_DELAY_MIN_MS = 4_000;
export const BASE_DELAY_MAX_MS = 9_000;
export const MAX_MULTIPLIER = 8;
export const CLEAN_SEARCHES_TO_RECOVER = 10;
export const PARSE_STOP_THRESHOLD = 0.9;
export const PARSE_MIN_SAMPLE = 20;
export const COVERAGE_MISS_LIMIT = 3;

export interface PaceState {
  delayMultiplier: number;
  cleanStreak: number;
}

export function nextDelayMs(multiplier: number, random = Math.random()): number {
  const base = BASE_DELAY_MIN_MS + random * (BASE_DELAY_MAX_MS - BASE_DELAY_MIN_MS);
  return Math.round(base * multiplier);
}

/** A CAPTCHA halves speed. */
export function afterBlock(state: PaceState): PaceState {
  return { delayMultiplier: Math.min(MAX_MULTIPLIER, state.delayMultiplier * 2), cleanStreak: 0 };
}

/** Slow or empty results add a longer pause. */
export function afterSlow(state: PaceState): PaceState {
  return { delayMultiplier: Math.min(MAX_MULTIPLIER, state.delayMultiplier * 1.5), cleanStreak: 0 };
}

/** A sustained clean run speeds back up, but never past the base rate. */
export function afterClean(state: PaceState): PaceState {
  const cleanStreak = state.cleanStreak + 1;
  if (cleanStreak < CLEAN_SEARCHES_TO_RECOVER) return { ...state, cleanStreak };
  return { delayMultiplier: Math.max(1, state.delayMultiplier / 1.25), cleanStreak: 0 };
}

export function parseSuccessTooLow(attempted: number, parsed: number): boolean {
  return attempted >= PARSE_MIN_SAMPLE && parsed / attempted < PARSE_STOP_THRESHOLD;
}
