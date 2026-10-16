/**
 * Types that describe how the HTTP layer is wired together.
 *
 * Keeping them in their own module means `router.ts`, the middleware and the
 * route handlers can all agree on the same shapes without importing each other.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The methods this API implements.
 *
 * Writing the union out by hand (rather than using `string`) means a typo like
 * `router.gett(...)` or `router.add('DELETE ')` is a compile error rather than a
 * route that silently never matches.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

/**
 * Everything a handler needs to know about the request in front of it.
 *
 * This is the single object that travels through the whole middleware pipeline
 * and ends up in the handler. Node hands us a bare `req` and `res`; we bundle
 * them with the parsed URL and the route parameters so handlers do not have to
 * re-parse anything.
 *
 * `req`, `res`, `method` and `url` are `readonly` because they are fixed for the
 * lifetime of the request. `params` is not readonly because the router only
 * learns the parameter values once it has matched a route, which happens after
 * the context is created.
 */
export interface RequestContext {
  /** The raw Node request stream (headers, body, socket). */
  readonly req: IncomingMessage;
  /** The raw Node response object we write into. */
  readonly res: ServerResponse;
  /**
   * The HTTP method, e.g. `'GET'`.
   *
   * Typed as `string` rather than `HttpMethod` because a client can send
   * anything (`HEAD`, `TRACE`, or outright nonsense). Node passes it through,
   * and it is the router's job to decide whether we support it.
   */
  readonly method: string;
  /** The parsed request target, so `pathname` and `searchParams` are ready to use. */
  readonly url: URL;
  /** Values captured from `:name` segments of the matched route, e.g. `{ id: '42' }`. */
  params: Record<string, string>;
}

/**
 * A function that produces the response for one endpoint.
 *
 * Returning `Promise<void> | void` lets a handler be `async` when it needs to
 * read the body or await I/O, and plain synchronous when it does not. The router
 * `await`s the result either way, which works because `await` on a non-promise
 * value simply yields that value.
 *
 * Notice that a handler does not *return* a response; it writes one into
 * `ctx.res`. That is a Node-level detail leaking through: our response helpers
 * (`sendJson`, `sendNoContent`) take the `ServerResponse` and end it. Frameworks
 * like Express hide this, but the underlying model is the same.
 */
export type RouteHandler = (ctx: RequestContext) => Promise<void> | void;

/**
 * Call this to run the next middleware in the chain.
 *
 * Awaiting it means "run the rest of the chain and come back when it is done",
 * which is what lets middleware wrap behaviour around the handler -- timing it,
 * catching its errors, adding headers afterwards.
 */
export type NextFunction = () => Promise<void>;

/**
 * One link in the pipeline.
 *
 * This is the same shape as Koa middleware, and it is the mental model behind
 * Express middleware too. A middleware either:
 *   - calls `await next()` and lets the request continue, or
 *   - responds itself and returns without calling `next()` (short-circuiting).
 */
export type Middleware = (ctx: RequestContext, next: NextFunction) => Promise<void> | void;
