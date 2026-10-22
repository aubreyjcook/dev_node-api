/**
 * Turning an array of middleware into a single function -- the "onion" model.
 *
 * This is about thirty lines, and it is the mechanism behind every middleware
 * system you have used in Node. Understanding it once removes a lot of mystery.
 */

import type { Middleware, NextFunction, RequestContext } from '../types/http.ts';

/**
 * Compose middleware into one function.
 *
 * Given `[a, b, c]`, calling the result runs `a`, and `a` decides whether to call
 * `b`, and so on. Control flows *down* the list to the handler and then back *up*
 * again as each `await next()` returns:
 *
 * ```
 *   logger  ──┐
 *   error   ──┼──┐
 *   cors    ──┼──┼──┐
 *   router  ──┼──┼──┼──▶ (handler responds)
 *   cors    ◀──┼──┼──┘
 *   error   ◀──┼──┘
 *   logger  ◀──┘
 * ```
 *
 * That return path is what lets a middleware measure how long the request took,
 * or catch an exception thrown five layers below it.
 *
 * The `index` bookkeeping is the standard guard from Koa's implementation. It
 * exists because `next()` must be callable at most once per middleware: calling
 * it twice would re-run the rest of the chain, which is almost always a bug and
 * produces genuinely baffling behaviour, so we throw instead.
 */
export function compose(
  middlewares: readonly Middleware[],
): (ctx: RequestContext) => Promise<void> {
  return async function runPipeline(ctx: RequestContext): Promise<void> {
    let lastIndex = -1;

    async function dispatch(index: number): Promise<void> {
      if (index <= lastIndex) {
        throw new Error(
          'next() was called more than once in a single middleware. Each middleware must call next() at most once.',
        );
      }
      lastIndex = index;

      const middleware = middlewares[index];
      // Running off the end of the list means every middleware has finished.
      // Note the explicit `undefined` check: `noUncheckedIndexedAccess` makes
      // `middlewares[index]` possibly undefined, and this doubles as the
      // loop-termination condition.
      if (middleware === undefined) {
        return;
      }

      // The `next` we hand to this middleware closes over `index`, so it always
      // resumes at the *following* middleware no matter how deeply nested the
      // calls get. This closure is the entire trick.
      const next: NextFunction = () => dispatch(index + 1);

      // `await` here is what makes the "return path" work. The middleware's own
      // code after `await next()` does not run until everything downstream of it
      // has completed.
      await middleware(ctx, next);
    }

    await dispatch(0);
  };
}
