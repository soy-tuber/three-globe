// Game time. The simulation counts minutes since its epoch; wall-clock values are derived.

export const MINUTES_PER_DAY = 24 * 60;
/** Japan Standard Time offset (the game is set in Japan). */
export const JST_OFFSET_MIN = 9 * 60;

/** Speed presets in game-minutes per real second. */
export const SPEEDS = [0, 2, 8, 30, 120] as const;
export type SpeedIndex = 0 | 1 | 2 | 3 | 4;

export interface ClockState {
  /** UTC epoch (ms) of simulation minute 0 */
  epochMs: number;
  /** elapsed simulation minutes */
  minutes: number;
}

export function nowMs(c: ClockState): number {
  return c.epochMs + c.minutes * 60_000;
}

/** Local (JST) hour-of-day in [0, 24). */
export function localHour(c: ClockState): number {
  const utcMin = nowMs(c) / 60_000;
  return (((utcMin + JST_OFFSET_MIN) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY / 60;
}

/** Local (JST) day index since the Unix epoch — changes at local midnight. */
export function localDay(c: ClockState): number {
  return Math.floor((nowMs(c) / 60_000 + JST_OFFSET_MIN) / MINUTES_PER_DAY);
}

export function formatJst(ms: number): { date: string; time: string; weekday: string } {
  const d = new Date(ms + JST_OFFSET_MIN * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    weekday: '日月火水木金土'[d.getUTCDay()],
  };
}
