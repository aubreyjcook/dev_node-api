/**
 * The error handling middleware -- the single place where a thrown error becomes
 * an HTTP response.
 *
 * This middleware sits near the outside of the pipeline, which is what makes it
 * able to catch anything thrown further in. The `try`/`catch` wraps
 * `await next()`, and because of how `compose` works, "further in" means the
 * entire rest of the request: routing, body parsing, validation, the store,
 * everything.
 *
 * The payoff is that no other file in this project contains a `try`/`catch` for
 * the purpose of producing an HTTP error. Handlers just `throw` and move on.
 */

import { HttpError, InternalServerError, MethodNotAllowedError } from '../http/errors.ts';
import { sendError } from '../http/response.ts';
import type { Middleware } from '../types/http.ts';

export interface ErrorHandlerOptions {
  /**
   * Print the full error, including its stack, for anything that maps to a 5xx.
   * Client errors (4xx) are not logged here -- they are normal traffic and are
   * already visible in the access log.
   */
  readonly logServerErrors?: boolean;
  /**
   * Include the original error's message in the response for unexpected errors.
   *
   * Extremely useful in development, where "Internal Server Error" with no detail
   * is maddening. Should be off in production, because internal error messages
   * regularly leak file paths, database names and library internals.
   */
  readonly exposeInternalErrors?: boolean;
}

/**
 * Convert any thrown value into an `HttpError`.
 *
 * The `unknown` parameter type is deliberate and important. In JavaScript you can
 * `throw` absolutely anything -- a string, a number, `undefined` -- so a `catch`
 * clause gives you no guarantees at all. TypeScript models that honestly by
 * typing caught values as `unknown` (under `strict`), and this function is where
 * that uncertainty gets resolved.
 */
function toHttpError(error: unknown, exposeInternalErrors: boolean): HttpError {
  // Our own deliberate errors are already in the right shape.
  if (error instanceof HttpError) {
    return error;
  }

  // Anything else is a bug or an unexpected failure. From the client's point of
  // view these are all the same: something went wrong that was not their fault.
  if (!exposeInternalErrors) {
    return new InternalServerError();
  }

  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new InternalServerError(
    `An unexpected internal error occurred (${detail}). This detail is only shown when NODE_ENV is not "production".`,
  );
}

/**
 * Create the error handling middleware.
 */
export function createErrorHandler(options: ErrorHandlerOptions = {}): Middleware {
  const logServerErrors = options.logServerErrors ?? true;
  const exposeInternalErrors = options.exposeInternalErrors ?? false;

  return async (ctx, next) => {
    try {
      await next();
    } catch (error: unknown) {
      const httpError = toHttpError(error, exposeInternalErrors);

      // Log the ORIGINAL error, not the translated one. By this point the 500 we
      // are about to send has thrown away everything useful, so if we only logged
      // `httpError` we would be logging our own generic message and the real stack
      // would be gone forever.
      if (httpError.status >= 500 && logServerErrors) {
        console.error(`[error] ${ctx.method} ${ctx.url.pathname} failed:`, error);
      }

      if (ctx.res.headersSent) {
        // We had already begun writing a response -- most likely a handler threw
        // midway through streaming a body. The status line and headers are on the
        // wire now and cannot be taken back, so there is no correct status code
        // left to send. Destroying the socket is the honest signal: the client
        // sees an incomplete response rather than a plausible-looking but
        // truncated one.
        ctx.res.destroy();
        return;
      }

      // A 405 is the one error that must also set a response header.
      //
      // The explicit `Record<string, string>` annotation is not decoration. Left
      // to infer, TypeScript would look at the two branches (`{ Allow: string }`
      // and `{}`) and synthesise `{ Allow: string } | { Allow?: undefined }`,
      // which is not assignable to the parameter type. Annotating the variable
      // gives the checker the target to work against instead of asking it to
      // invent one.
      const extraHeaders: Record<string, string> =
        httpError instanceof MethodNotAllowedError
          ? { Allow: httpError.allowed.join(', ') }
          : {};

      sendError(ctx.res, httpError, extraHeaders);
    }
  };
}
