/**
 * A very small router.
 *
 * This file is the heart of the "build it yourself" part of the project. It does
 * three things:
 *
 *   1. Stores a table of routes, each a (method, path pattern, handler) triple.
 *   2. Matches an incoming request against that table.
 *   3. Calls the matching handler, or throws the right `HttpError` if nothing
 *      matches.
 *
 * Express, Fastify and Koa all do exactly this, with far more features and a lot
 * more care taken over performance. Reading this file should make `router.get('/x', fn)`
 * stop feeling like magic.
 */

import {
  BadRequestError,
  MethodNotAllowedError,
  NotFoundError,
} from './http/errors.ts';
import type { RequestContext, RouteHandler, HttpMethod } from './types/http.ts';

/**
 * One registered route.
 *
 * `segments` is the pre-split path pattern, e.g. `'/api/tasks/:id'` becomes
 * `['api', 'tasks', ':id']`. Splitting once at registration rather than on every
 * request is a small optimisation, but more importantly it makes the matching
 * code below much easier to follow.
 */
interface Route {
  readonly method: HttpMethod;
  /** The original pattern, kept only for error messages. */
  readonly path: string;
  /** The pattern split on `/`, with empty segments removed. */
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

/**
 * Split a path into its meaningful segments.
 *
 * `'/api/tasks/'` -> `['api', 'tasks']`
 * `'/'`           -> `[]`
 *
 * Filtering out empty strings is what makes a trailing slash harmless: the URLs
 * `/api/tasks` and `/api/tasks/` produce identical segments, so both match the
 * same route. Users type trailing slashes constantly, and 404-ing them would be
 * unfriendly.
 */
function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * Try to match one route's segments against the request's segments.
 *
 * Returns the captured parameters on success, or `undefined` if the path does
 * not match. Note the return type: `undefined` for "no match" rather than
 * `null`, and an empty object `{}` for "matched, no parameters". Those are
 * genuinely different outcomes, and this is a good example of why the
 * `T | undefined` pattern shows up everywhere in TypeScript -- the type checker
 * will not let a caller forget to handle the no-match case.
 */
function matchSegments(
  patternSegments: readonly string[],
  pathSegments: readonly string[],
): Record<string, string> | undefined {
  // A different number of segments can never match. This is also the reason
  // `/api/tasks/42/notes` does not match `/api/tasks/:id`.
  if (patternSegments.length !== pathSegments.length) {
    return undefined;
  }

  const params: Record<string, string> = {};

  // `.entries()` gives us `[index, value]` pairs, and destructuring them in the
  // loop header keeps the body tidy.
  for (const [index, patternSegment] of patternSegments.entries()) {
    const pathSegment = pathSegments[index];

    // With `noUncheckedIndexedAccess` enabled, TypeScript types this as
    // `string | undefined` even though the length check above proves it is
    // present. Rather than paper over that with a `!` (which would disable
    // checking) we handle the case explicitly. Guards like this cost nothing and
    // keep the compiler's view and reality in agreement.
    if (pathSegment === undefined) {
      return undefined;
    }

    // A segment starting with `:` is a wildcard that captures whatever is there.
    if (patternSegment.startsWith(':')) {
      const name = patternSegment.slice(1);
      try {
        // `url.pathname` keeps percent-encoding intact, so a client asking for
        // `/api/tasks/hello%20world` arrives here as `hello%20world`. Decoding
        // gives the handler the value the client meant.
        params[name] = decodeURIComponent(pathSegment);
      } catch {
        // decodeURIComponent throws a URIError on a malformed escape sequence
        // such as `%zz`. That is the client's fault, so it is a 400.
        throw new BadRequestError(
          `The URL contains an invalid percent-encoded escape sequence: "${pathSegment}".`,
        );
      }
      continue;
    }

    // A literal segment must match exactly. Comparison is case-sensitive, which
    // is the safe default: `/api/Tasks` is a different URL from `/api/tasks`.
    if (patternSegment !== pathSegment) {
      return undefined;
    }
  }

  return params;
}

/**
 * The router.
 *
 * Note that routes are checked in registration order and *all* path-matching
 * routes are collected before the method is considered. That extra step is what
 * makes a correct `405 Method Not Allowed` possible: to answer "PATCH is not
 * allowed here" we must first know that other methods *are* allowed, which means
 * matching on path alone.
 */
export class Router {
  /**
   * A private field using JavaScript's `#` syntax, not TypeScript's `private`.
   *
   * `private` is purely a compile-time fiction -- the property is still a normal,
   * enumerable, reachable property at runtime. `#` is enforced by the JavaScript
   * engine itself. Prefer `#` when you actually want encapsulation.
   */
  readonly #routes: Route[] = [];

  /**
   * Register a route.
   *
   * Returns `this` so registrations can be chained:
   * `router.get('/a', h).get('/b', h)`. This is the same "return this" trick that
   * powers jQuery and most fluent APIs.
   *
   * The parameter names are validated here, at startup, rather than on the first
   * request. Configuration mistakes should crash the process immediately, when
   * the fix is obvious, and never become a runtime surprise in production.
   */
  add(method: HttpMethod, path: string, handler: RouteHandler): this {
    if (!path.startsWith('/')) {
      throw new Error(`Route path "${path}" must start with "/".`);
    }

    const segments = splitPath(path);
    const seenNames = new Set<string>();

    for (const segment of segments) {
      if (!segment.startsWith(':')) {
        continue;
      }
      const name = segment.slice(1);
      if (name.length === 0) {
        throw new Error(`Route path "${path}" contains an empty parameter name (a bare ":").`);
      }
      if (seenNames.has(name)) {
        // Duplicates would silently overwrite each other in the params object,
        // which is confusing to debug. Better to refuse at startup.
        throw new Error(`Route path "${path}" uses the parameter name "${name}" more than once.`);
      }
      seenNames.add(name);
    }

    this.#routes.push({ method, path, segments, handler });
    return this;
  }

  /** Register a `GET` route. */
  get(path: string, handler: RouteHandler): this {
    return this.add('GET', path, handler);
  }

  /** Register a `POST` route. */
  post(path: string, handler: RouteHandler): this {
    return this.add('POST', path, handler);
  }

  /** Register a `PUT` route. */
  put(path: string, handler: RouteHandler): this {
    return this.add('PUT', path, handler);
  }

  /** Register a `PATCH` route. */
  patch(path: string, handler: RouteHandler): this {
    return this.add('PATCH', path, handler);
  }

  /**
   * Register a `DELETE` route.
   *
   * `delete` is a reserved word in JavaScript, but reserved words are perfectly
   * legal as *method* names, so `router.delete(...)` works fine.
   */
  delete(path: string, handler: RouteHandler): this {
    return this.add('DELETE', path, handler);
  }

  /**
   * Find the handler for this request and run it.
   *
   * This method is itself the terminal middleware in the pipeline, which is a
   * neat way to think about it: from the pipeline's point of view, "routing" is
   * just the last thing that happens, and it either responds or throws.
   */
  async dispatch(ctx: RequestContext): Promise<void> {
    const pathSegments = splitPath(ctx.url.pathname);

    // Collect every route whose *path* matches, regardless of method.
    const pathMatches: { route: Route; params: Record<string, string> }[] = [];
    for (const route of this.#routes) {
      const params = matchSegments(route.segments, pathSegments);
      if (params !== undefined) {
        pathMatches.push({ route, params });
      }
    }

    // Nothing matched the path at all -> 404.
    if (pathMatches.length === 0) {
      throw new NotFoundError(`No resource exists at ${ctx.method} ${ctx.url.pathname}.`);
    }

    // The path exists; now does it support this method?
    const methodMatch = pathMatches.find((candidate) => candidate.route.method === ctx.method);
    if (methodMatch === undefined) {
      // A `Set` removes duplicates, so two routes on the same path both allowing
      // GET would not produce "GET, GET". Sorting makes the header deterministic,
      // which matters because response headers are compared in tests and caches.
      const allowed = [...new Set(pathMatches.map((candidate) => candidate.route.method))];
      // OPTIONS is always available: the CORS middleware answers preflight
      // requests before routing even happens, for every path.
      allowed.push('OPTIONS');
      allowed.sort();
      throw new MethodNotAllowedError(allowed);
    }

    // Publish the captured parameters, then delegate. Note that we do not return
    // the handler's promise -- we await it, so a rejection propagates to the
    // error handler as a thrown exception.
    ctx.params = methodMatch.params;
    await methodMatch.route.handler(ctx);
  }
}
