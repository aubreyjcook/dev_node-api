/**
 * CORS -- Cross-Origin Resource Sharing.
 *
 * **The problem it solves.** A browser will not let JavaScript running on
 * `https://app.example.com` read a response from `https://api.example.com` unless
 * that API explicitly opts in. This is the *same-origin policy*, and it is a
 * security feature: without it, any website you visit could quietly make requests
 * to your bank using your cookies.
 *
 * CORS is the mechanism for opting out of that restriction, per-origin. The
 * server says "I allow `https://app.example.com` to read my responses", and the
 * browser enforces it. Note carefully: **the server does not block anything.**
 * CORS is enforced by the browser. A `curl` command or a server-to-server call
 * ignores these headers entirely. If you need real access control, that is
 * authentication, which is a completely separate concern.
 *
 * **Two kinds of request.** A "simple" request (a `GET`, or a `POST` with a
 * basic content type) is sent directly, and the browser checks the CORS headers on
 * the actual response. Anything else -- a `PUT`, a `DELETE`, or a request with
 * `Content-Type: application/json` -- triggers a *preflight*: the browser first
 * sends an `OPTIONS` request asking "would you allow a PUT with this content
 * type?", and only sends the real request if the answer is yes. Since almost
 * every write to a JSON API is preflighted, handling `OPTIONS` is not optional.
 */

import { sendNoContent } from '../http/response.ts';
import type { Middleware } from '../types/http.ts';

export interface CorsOptions {
  /**
   * The value for `Access-Control-Allow-Origin`.
   *
   * `'*'` means any origin. Convenient while learning, but it cannot be combined
   * with credentials (cookies) -- the browser rejects that combination -- and it
   * means every website can call your API from a visitor's browser.
   */
  readonly origin: string;
  /** Methods advertised to the browser in a preflight response. */
  readonly methods: readonly string[];
  /** Request headers the client is allowed to send. */
  readonly headers: readonly string[];
}

/**
 * Create the CORS middleware.
 */
export function createCors(options: CorsOptions): Middleware {
  return async (ctx, next) => {
    const { res } = ctx;

    // Set the simple-response headers first, so they are present on *every*
    // response -- including successful writes, 404s and 500s. A browser cannot
    // read an error response that lacks these, which turns a clear "422 bad
    // input" into a mysterious opaque network failure in the console.
    res.setHeader('Access-Control-Allow-Origin', options.origin);

    if (options.origin !== '*') {
      // `Vary` tells caches that the response depends on the request's `Origin`
      // header, so a cached response for one origin is never replayed to another.
      // With `'*'` the response is identical for everyone, so `Vary` is pointless.
      res.setHeader('Vary', 'Origin');
    }

    // Preflight. Answer it here and stop: there is no resource to act on, and the
    // router has no OPTIONS routes for every path, so letting this fall through
    // would produce a 405.
    if (ctx.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', options.methods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', options.headers.join(', '));
      // Let the browser cache this preflight for a day, so it stops asking
      // before every single write. Without it, each PUT costs two round trips.
      res.setHeader('Access-Control-Max-Age', '86400');
      // Also answer according to the HTTP spec, for non-browser clients.
      res.setHeader('Allow', options.methods.join(', '));

      // 204 No Content is the conventional preflight response: there is nothing
      // to return, the headers are the entire answer.
      sendNoContent(res);
      return;
    }

    await next();
  };
}
