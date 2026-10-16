/**
 * Request logging middleware.
 *
 * This is the classic demonstration of why the middleware signature takes a
 * `next` function. At the moment this middleware starts, the response has not
 * been produced yet -- there is no status code to log. Only after
 * `await next()` returns does the whole downstream chain know the outcome.
 *
 * This middleware is placed *outside* the error handler in the pipeline, so by
 * the time control returns here, even a 500 has already been converted into a
 * real response and `res.statusCode` is accurate.
 */

import type { Middleware } from '../types/http.ts';

/**
 * Colour is nice in a terminal and actively harmful in a log file, where it
 * shows up as `\u001b[32m` noise. So we only colour when standard output is an
 * interactive terminal, and we honour the `NO_COLOR` convention
 * (https://no-color.org) that many tools and users set to opt out.
 */
const COLOURS_ENABLED =
  process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

const RESET = COLOURS_ENABLED ? '\u001b[0m' : '';
const BOLD = COLOURS_ENABLED ? '\u001b[1m' : '';
const DIM = COLOURS_ENABLED ? '\u001b[2m' : '';

/**
 * Pick a colour by status class.
 *
 * Green for success, cyan for redirects (which this API does not use, but the
 * function stays honest about the whole range), yellow for client mistakes, and
 * red for server mistakes. Scanning for red is a quick way to spot problems.
 */
function colourForStatus(status: number): string {
  if (!COLOURS_ENABLED) {
    return '';
  }
  if (status >= 500) {
    return '\u001b[31m'; // red
  }
  if (status >= 400) {
    return '\u001b[33m'; // yellow
  }
  if (status >= 300) {
    return '\u001b[36m'; // cyan
  }
  return '\u001b[32m'; // green
}

export interface LoggerOptions {
  /** When false, the middleware still calls `next()`, it just logs nothing. */
  readonly enabled: boolean;
}

/**
 * Create the logging middleware.
 *
 * A factory function returning the actual middleware is a very common pattern.
 * It gives you a place to put configuration and captured state, and it means
 * each part of the app can have its own configured instance.
 */
export function createLogger(options: LoggerOptions): Middleware {
  return async (ctx, next) => {
    if (!options.enabled) {
      // Note that we still forward the request. A disabled logger is silent, not
      // a blocker -- if it returned without calling next(), the API would stop
      // working entirely.
      await next();
      return;
    }

    // `process.hrtime.bigint()` reads a monotonic clock: it only ever moves
    // forward and is unaffected by the system clock being adjusted (NTP, time
    // zones, daylight saving). `Date.now()` can jump backwards mid-request and
    // produce a negative duration. Use hrtime for measuring elapsed time.
    const startedAt = process.hrtime.bigint();

    try {
      await next();
    } finally {
      // `finally` guarantees we log even when the downstream chain throws. Note
      // that we deliberately do NOT catch here -- the error continues to
      // propagate to the error handler after we have logged the attempt.
      const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
      const elapsedMs = Number(elapsedNanoseconds) / 1_000_000;

      const status = ctx.res.statusCode;
      const colour = colourForStatus(status);
      const time = new Date().toISOString().slice(11, 23);
      // `ctx.url.search` includes the leading '?' and is the empty string when
      // there is no query string, which reads nicely in the log line.
      const target = `${ctx.url.pathname}${ctx.url.search}`;

      console.log(
        `${DIM}${time}${RESET} ` +
          `${BOLD}${ctx.method.padEnd(6)}${RESET} ` +
          `${target} ` +
          `${colour}${status}${RESET} ` +
          `${DIM}${elapsedMs.toFixed(1)}ms${RESET}`,
      );
    }
  };
}
