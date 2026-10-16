/**
 * Building the application.
 *
 * This module wires everything together and hands back a single request listener
 * that Node can serve. It deliberately does **not** listen on a port -- that
 * belongs to `server.ts`.
 *
 * Why the split matters: the automated tests import this file, build an app, and
 * listen on a random free port themselves. If this module started a server on
 * import, every test file would fight over port 3000 and the tests could not run
 * in parallel.
 *
 * ## The middleware order is load-bearing
 *
 * ```
 *   logger      -> wraps everything, so it can log the final status and duration
 *     errorHandler  -> converts any thrown error into a response
 *       defaultHeaders -> Cache-Control, nosniff
 *         cors           -> sets CORS headers; answers OPTIONS and stops there
 *           router          -> matches the request and runs the handler
 * ```
 *
 * A useful way to read this: each middleware can rely on everything *inside* it,
 * and must cope with everything *outside* it. The logger is outside the error
 * handler, so it can trust that by the time it regains control, the response is
 * finished. The error handler is outside the router, so it can trust that
 * anything the router or a handler throws will reach it.
 *
 * Swap the first two and error responses get logged as `200`, because the logger
 * would read `res.statusCode` before the error handler had set it. Middleware
 * order is not decoration; it is program structure.
 */

import type { RequestListener } from 'node:http';
import { config } from './config.ts';
import { TaskStore } from './data/task.store.ts';
import { sampleTasks } from './data/seed.ts';
import { createRequestContext } from './http/context.ts';
import { sendJson } from './http/response.ts';
import { compose } from './middleware/compose.ts';
import { createCors } from './middleware/cors.ts';
import { createDefaultHeaders } from './middleware/defaultHeaders.ts';
import { createErrorHandler } from './middleware/errorHandler.ts';
import { createLogger } from './middleware/logger.ts';
import { Router } from './router.ts';
import { registerHealthRoutes } from './routes/health.routes.ts';
import { registerTaskRoutes } from './routes/tasks.routes.ts';
import type { Middleware, RequestContext } from './types/http.ts';

/**
 * Options for `buildApp`.
 *
 * Every field is optional and falls back to the corresponding `config` value, so
 * `buildApp()` does the right thing in production while a test can override just
 * the one thing it cares about:
 *
 * ```ts
 * const app = buildApp({ seed: false, logRequests: false });
 * ```
 */
export interface BuildAppOptions {
  /** Populate the store with the sample tasks. Defaults to `config.seedData`. */
  readonly seed?: boolean;
  /** Log each request to standard output. Defaults to `config.logRequests`. */
  readonly logRequests?: boolean;
  /** Value for the `Access-Control-Allow-Origin` header. Defaults to `config.corsOrigin`. */
  readonly corsOrigin?: string;
  /** Maximum request body size in bytes. Defaults to `config.maxBodyBytes`. */
  readonly maxBodyBytes?: number;
}

/**
 * The assembled application.
 *
 * Exposing `store` and `router` is a pragmatic choice for a learning project: it
 * lets a test inspect or reset the store directly, and it lets you poke at the
 * registered routes in a REPL.
 */
export interface App {
  readonly router: Router;
  readonly store: TaskStore;
  /** The composed middleware pipeline, exposed for testing and debugging. */
  readonly pipeline: (ctx: RequestContext) => Promise<void>;
  /** The function to hand to `http.createServer`. */
  readonly listener: RequestListener;
}

/** Methods advertised to browsers in a CORS preflight response. */
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/**
 * Request headers a browser is allowed to send.
 *
 * `Content-Type` must be listed or every JSON write is blocked by the browser's
 * preflight check. `Accept` is listed because clients commonly set it.
 *
 * Note that `X-Total-Count` is a *response* header and so does not belong here.
 * To let browser JavaScript read a custom response header you need
 * `Access-Control-Expose-Headers` instead -- which is exactly the kind of detail
 * that makes CORS worth reading about properly before you rely on it.
 */
const ALLOWED_HEADERS = ['Content-Type', 'Accept'];

/**
 * Wire up the store, the routes and the middleware, and return the app.
 */
export function buildApp(options: BuildAppOptions = {}): App {
  // ---- Data -------------------------------------------------------------
  const store = new TaskStore();
  if (options.seed ?? config.seedData) {
    store.seed(sampleTasks);
  }

  // ---- Routes -----------------------------------------------------------
  const router = new Router();
  registerHealthRoutes(router);
  registerTaskRoutes(router, {
    store,
    maxBodyBytes: options.maxBodyBytes ?? config.maxBodyBytes,
  });

  // ---- Middleware -------------------------------------------------------
  const middlewares: readonly Middleware[] = [
    createLogger({ enabled: options.logRequests ?? config.logRequests }),
    createErrorHandler({
      // Show the underlying error message for 500s everywhere except production.
      // A learner staring at "Internal Server Error" with no detail will lose an
      // hour; a production user seeing a stack trace will lose you a customer.
      exposeInternalErrors: config.nodeEnv !== 'production',
    }),
    createDefaultHeaders(),
    createCors({
      origin: options.corsOrigin ?? config.corsOrigin,
      methods: ALLOWED_METHODS,
      headers: ALLOWED_HEADERS,
    }),
    // The router is just the final middleware. A function that ignores its second
    // parameter is a valid `Middleware`, so this needs no wrapper.
    (ctx) => router.dispatch(ctx),
  ];

  const pipeline = compose(middlewares);

  // ---- The Node request listener ----------------------------------------
  const listener: RequestListener = (req, res) => {
    const ctx = createRequestContext(req, res);

    // `pipeline(ctx)` returns a promise, and Node's request listener does not
    // await it -- Node is not interested in our promise, it only cares that the
    // response eventually gets written. So **we** must handle rejection.
    //
    // An unhandled promise rejection terminates the Node process by default,
    // which means one malformed request could take down the whole server. This
    // `.catch` is the last line of defence: it should be unreachable, because the
    // error handler sits inside the pipeline, but "should be unreachable" is not
    // a security model.
    pipeline(ctx).catch((error: unknown) => {
      console.error('[fatal] An error escaped the middleware pipeline:', error);

      if (res.headersSent) {
        // Mid-response, so the only honest signal left is to drop the connection.
        res.destroy();
        return;
      }

      // Deliberately hand-written rather than using `sendError`, so this path
      // depends on as little of our own code as possible.
      sendJson(res, 500, {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred.',
        },
      });
    });
  };

  return { router, store, pipeline, listener };
}
