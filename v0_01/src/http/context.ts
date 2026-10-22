/**
 * Building and reading the per-request context.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { InternalServerError } from './errors.ts';
import type { RequestContext } from '../types/http.ts';

/**
 * Turn Node's `req`/`res` pair into the `RequestContext` the rest of the app uses.
 *
 * **Why we parse the URL by hand.** `req.url` is only the *request target*, not a
 * full URL -- for a normal request it looks like `/api/tasks?limit=10#top`. To
 * get a `URL` object we need a base to resolve it against, and HTTP gives us one
 * in the `Host` header. So `new URL('/api/tasks?limit=10', 'http://127.0.0.1:3000')`
 * produces a fully parsed URL with `.pathname`, `.searchParams` and friends.
 *
 * Using the built-in `URL` class rather than splitting strings ourselves means
 * percent-decoding, query parsing and edge cases are all handled correctly by the
 * platform.
 *
 * The `?? 'localhost'` fallback covers HTTP/1.0 requests and hand-written test
 * clients, which are allowed to omit `Host`. Since we only use it to satisfy the
 * URL parser and never to route, an arbitrary value is fine here.
 */
export function createRequestContext(
  req: IncomingMessage,
  res: ServerResponse,
): RequestContext {
  const host = req.headers.host ?? 'localhost';
  const target = req.url ?? '/';

  return {
    req,
    res,
    // `req.method` is optional in Node's types; defaulting to 'GET' keeps the
    // type a plain `string` and gives a sane answer for a malformed request.
    method: req.method ?? 'GET',
    url: new URL(target, `http://${host}`),
    // Filled in by the router once a route matches.
    params: {},
  };
}

/**
 * Read a route parameter, failing loudly if it is missing.
 *
 * Handlers "know" that a route like `/api/tasks/:id` always populates `params.id`,
 * but TypeScript does not: `params` is a `Record<string, string>`, so
 * `ctx.params['id']` is typed `string | undefined`. This helper turns that
 * awkwardness into one clear failure mode.
 *
 * If this ever throws, the bug is in *our* code -- a handler registered on a
 * route without that parameter -- not in the client's request. That is why it is
 * a 500, and why the message is worth reading in the logs.
 */
export function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (value === undefined) {
    throw new InternalServerError(
      `Route parameter "${name}" is missing. This is a bug in the route registration, not in the request.`,
    );
  }
  return value;
}
