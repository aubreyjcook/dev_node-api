/**
 * The health check endpoint.
 *
 * Every API that will ever be deployed should have one. Monitoring tools,
 * container orchestrators (Kubernetes readiness and liveness probes), and load
 * balancers all need a cheap way to ask "are you alive and ready for traffic?".
 * Without a dedicated endpoint they end up probing a real resource, which is
 * wasteful and gives misleading answers when that resource is legitimately
 * empty.
 *
 * Note what is *not* here: no authentication, no database query, nothing that
 * could be slow. A health check that depends on something fallible is a health
 * check that will report your service as down for reasons that have nothing to
 * do with it. A deeper "is everything working?" check belongs on a separate
 * endpoint, usually called something like `/health/ready`.
 */

import { sendJson } from '../http/response.ts';
import type { Router } from '../router.ts';

/**
 * Register the health routes on the given router.
 *
 * Routes are registered through a function like this rather than exported as a
 * ready-made router so that the router instance stays owned by `app.ts`. Whoever
 * builds the application decides what goes into it; these modules only describe
 * how to add their piece.
 */
export function registerHealthRoutes(router: Router): void {
  /**
   * `GET /health` -- an unauthenticated liveness probe.
   *
   * Returns 200 with a small JSON body. Note that this is *not* under `/api`,
   * because it is infrastructure rather than part of the API proper. That is a
   * convention, not a rule, but it is a widely followed one.
   */
  router.get('/health', (ctx) => {
    sendJson(ctx.res, 200, {
      status: 'ok',
      // `process.uptime()` is the number of seconds this Node process has been
      // running. Rounding keeps the response tidy; sub-second precision in an
      // uptime figure is noise.
      uptimeSeconds: Math.round(process.uptime()),
      // `process.version` is the Node version actually running, e.g. 'v24.22.0'.
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
    });
  });
}
