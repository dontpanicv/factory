import { useEffect, useState } from "preact/hooks";

/** Times as people read them, and a clock for the pages. */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const TICK_MS = 15_000;

/** A short age: `now`, `4m`, `3h`, `2d`. */
export const shortAge = (time: number, now: number) => {
  const delta = Math.max(0, now - time);
  if (delta < MINUTE_MS) {
    return "now";
  }
  if (delta < HOUR_MS) {
    return `${Math.floor(delta / MINUTE_MS)}m`;
  }
  if (delta < DAY_MS) {
    return `${Math.floor(delta / HOUR_MS)}h`;
  }
  return `${Math.floor(delta / DAY_MS)}d`;
};

const SECOND = 1000;
const MINUTE = 60;
const HOUR = 3600;

/** A length of time in two units at most: `42s`, `3m 10s`, `2h 5m`. */
export const duration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / SECOND));
  if (seconds < MINUTE) {
    return `${seconds}s`;
  }
  if (seconds < HOUR) {
    return `${Math.floor(seconds / MINUTE)}m ${seconds % MINUTE}s`;
  }
  return `${Math.floor(seconds / HOUR)}h ${Math.floor((seconds % HOUR) / MINUTE)}m`;
};

/** The time now, again each quarter of a minute: the ages on a page stay correct. */
export const useNow = () => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
};
