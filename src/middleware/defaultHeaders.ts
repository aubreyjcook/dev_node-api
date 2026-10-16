/**
 * Default response headers.
 *
 * A tiny middleware, but it makes a point worth internalising: every response
 * this API produces -- success or failure -- is dynamic and per-request, and
 * nothing downstream can forget to say so, because it is declared here once.
 */

import type { Middleware } from '../types/http.ts';

/**
 * Create the default-headers middleware.
 */
export function createDefaultHeaders(): Middleware {
  return async (ctx, next) => {
    // `no-store` tells every cache in the path -- the browser, a corporate proxy,
    // a CDN -- not to keep a copy. This API returns mutable data addressed by
    // URL, so a cached `GET /api/tasks` could hand a user a stale list after they
    // just created a task. Correct caching is possible but needs `ETag` and
    // `Cache-Control: max-age` worked out per resource; until then, honesty is
    // safer than a stale cache.
    ctx.res.setHeader('Cache-Control', 'no-store');

    // Stops a browser from "sniffing" the content type and deciding that a JSON
    // response is really HTML or JavaScript. Without it, a crafted response body
    // could be executed as a script in some older browsers. Cheap insurance.
    ctx.res.setHeader('X-Content-Type-Options', 'nosniff');

    await next();
  };
}
