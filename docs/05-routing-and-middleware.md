# 05 — Routing and middleware

Two mechanisms do most of the work in any web framework, and this project implements both from scratch in under 200 lines combined. Understanding them removes most of the mystery from Express, Fastify, Koa and everything built on the same ideas.

- **[Part 1](#part-1-routing)** takes `src/router.ts` apart: how a URL like `/api/tasks/42` becomes a call to a function, and why the naive approach breaks a specific HTTP requirement.
- **[Part 2](#part-2-middleware)** takes `src/middleware/compose.ts` apart: thirty lines that produce the "onion" model, and why the order you list middleware in is program structure rather than decoration.

If you only read one, read Part 2. The routing idea is intuitive; the middleware idea is the one that takes a moment to click.

---

# Part 1: Routing

## 1. The problem

An HTTP server receives a stream of bytes. After parsing, Node hands you a method and a path:

```
GET  /api/tasks/4656e53e-35e3-4314-b863-6cc1c05d7fd5
POST /api/tasks
DEL  /health
```

You have some functions. You need to decide which one to call. Furthermore, the `4656e53e-...` part is *data* — it is specific to this request — while `/api/tasks/` is *structure*, which is the same for every request of this kind.

Routing is the act of separating one from the other.

A naive router would be a lookup table:

```ts
// Do NOT do this.
const routes = new Map<string, Handler>();
routes.set('/health', healthHandler);
routes.set('/api/tasks', tasksHandler);
```

That works until you need `/api/tasks/4656e53e-...`, because there is no sensible way to write every possible UUID into a map. What you want is to say:

> "Any path that starts with `/api/tasks/` followed by exactly one more segment — call it `id` — should call this handler, and put that segment in `params.id`."

That is a **path pattern**, and `/api/tasks/:id` is the conventional way to write it. The colon marks a *capture group*.

Everything else in this part of the chapter is detail about matching those patterns correctly.

## 2. What the router stores

`Router.add` does no matching. It validates the pattern once, at startup, and pushes a record:

```ts
interface Route {
  readonly method: HttpMethod;
  readonly path: string;                  // the original pattern, for error messages
  readonly segments: readonly string[];   // ['api', 'tasks', ':id']
  readonly handler: RouteHandler;
}
```

Storing the pattern **pre-split** is a small optimisation, but the more important effect is on readability: the matching code never has to think about slashes.

The validation at registration time is worth copying into any router you write:

```ts
for (const segment of segments) {
  if (!segment.startsWith(':')) continue;

  const name = segment.slice(1);
  if (name.length === 0) {
    throw new Error(`Route path "${path}" contains an empty parameter name (a bare ":").`);
  }
  if (seenNames.has(name)) {
    throw new Error(`Route path "${path}" uses the parameter name "${name}" more than once.`);
  }
  seenNames.add(name);
}
```

Both checks catch mistakes that would otherwise be invisible. A duplicate parameter name would silently overwrite itself in the `params` object, so `/api/x/:id/y/:id` would capture one value and quietly lose the other. Failing at startup — when the fix is obvious and the stack trace points at the offending line — is enormously better than failing during a request in production three weeks later.

That is a general principle worth stating plainly: **configuration errors should crash the process immediately, not become runtime surprises.**

## 3. Matching, step by step

Here is the whole matcher:

```ts
function matchSegments(
  patternSegments: readonly string[],
  pathSegments: readonly string[],
): Record<string, string> | undefined {
  if (patternSegments.length !== pathSegments.length) {
    return undefined;
  }

  const params: Record<string, string> = {};

  for (const [index, patternSegment] of patternSegments.entries()) {
    const pathSegment = pathSegments[index];

    if (pathSegment === undefined) {
      return undefined;
    }

    if (patternSegment.startsWith(':')) {
      const name = patternSegment.slice(1);
      try {
        params[name] = decodeURIComponent(pathSegment);
      } catch {
        throw new BadRequestError(
          `The URL contains an invalid percent-encoded escape sequence: "${pathSegment}".`,
        );
      }
      continue;
    }

    if (patternSegment !== pathSegment) {
      return undefined;
    }
  }

  return params;
}
```

The return type deserves a pause, because it is a case study in TypeScript design:

```ts
Record<string, string> | undefined
```

- `undefined` means **did not match**.
- `{}` means **matched, and captured nothing**.

Those are genuinely different outcomes, and the type keeps them apart. If the function returned `null` for no-match and `{}` for a match with no parameters, a caller could easily write `if (!params)` and get the wrong answer for `/health`, where `{}` is truthy but a careless `if (result)` on a falsy sentinel pattern would be a bug waiting to happen.

More importantly, `T | undefined` is a type the compiler **forces** you to handle. `noUncheckedIndexedAccess` and `strictNullChecks` mean you cannot accidentally use the result without checking it. That is the single most valuable habit TypeScript encourages.

### A worked example

Request: `GET /api/tasks/4656e53e`

Split: `['api', 'tasks', '4656e53e']`

| Route pattern | Pattern segments | Length matches? | Segment-by-segment | Result |
|---|---|---|---|---|
| `/health` | `['health']` | 1 ≠ 3 — **no** | (skipped) | no match |
| `/api/tasks` | `['api','tasks']` | 2 ≠ 3 — **no** | (skipped) | no match |
| `/api/tasks/:id` | `['api','tasks',':id']` | 3 = 3 — **yes** | `api`=`api` ✓, `tasks`=`tasks` ✓, `:id` captures `4656e53e` | **match**, `{ id: '4656e53e' }` |

Now the same table for `GET /api/tasks`:

| Route pattern | Length matches? | Result |
|---|---|---|
| `/health` | 1 ≠ 2 — **no** | no match |
| `/api/tasks` | 2 = 2 — **yes** | all literal segments equal → **match**, `{}` |
| `/api/tasks/:id` | 3 ≠ 2 — **no** | no match |

The length check first is not just an optimisation. It is what stops `/api/tasks/42/notes` from matching `/api/tasks/:id` — three segments against two is impossible, so there is no way for the extra `notes` to be silently swallowed into `id`.

### The `pathSegment === undefined` guard

That check is unreachable in practice: the length comparison above guarantees the index is valid. It exists entirely because `noUncheckedIndexedAccess` types `pathSegments[index]` as `string | undefined` regardless.

You have three choices when the compiler is more cautious than you are:

```ts
// 1. Assert. Silences the compiler and disables checking.
params[name] = decodeURIComponent(pathSegments[index]!);

// 2. Cast.
params[name] = decodeURIComponent(pathSegments[index] as string);

// 3. Handle it.
const pathSegment = pathSegments[index];
if (pathSegment === undefined) return undefined;
```

This project uses the third. It costs one line, it cannot become wrong if the surrounding logic is later changed, and it documents the invariant to the next reader. Option 1 is the option to reach for only when you have genuinely exhausted the alternatives, and it is worth being suspicious of codebases where `!` is common — each one is a place where the compiler was told to stop helping.

## 4. Why the path is matched before the method

This is the most interesting decision in the file, and it exists to serve one HTTP requirement.

A naive router walks its route table and asks, for each route, "does the method AND the path match?":

```ts
// A subtly wrong router.
for (const route of this.#routes) {
  if (route.method === ctx.method && matches(route.segments, pathSegments)) {
    return route.handler(ctx);
  }
}
throw new NotFoundError('no route matched');
```

Feed it `PATCH /api/tasks` and it throws `404 Not Found`. But `/api/tasks` **does exist** — it just does not support `PATCH`. The correct answer is `405 Method Not Allowed`, and RFC 9110 requires a 405 response to include an `Allow` header listing the methods that *are* supported.

You cannot produce that header if you stopped at the first route whose method did not match. To say "PATCH is not allowed here", you must first establish that `GET` and `POST` *are*.

So `dispatch` runs in two phases:

```ts
async dispatch(ctx: RequestContext): Promise<void> {
  const pathSegments = splitPath(ctx.url.pathname);

  // Phase 1: collect EVERY route whose path matches, whatever its method.
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

  // Phase 2: now does this path support this method?
  const methodMatch = pathMatches.find((candidate) => candidate.route.method === ctx.method);
  if (methodMatch === undefined) {
    const allowed = [...new Set(pathMatches.map((candidate) => candidate.route.method))];
    allowed.push('OPTIONS');
    allowed.sort();
    throw new MethodNotAllowedError(allowed);
  }

  ctx.params = methodMatch.params;
  await methodMatch.route.handler(ctx);
}
```

Three details in the 405 branch:

**`new Set(...)` de-duplicates.** If two routes on the same path both allowed `GET`, a naive `map` would produce `"GET, GET"`.

**`sort()` makes it deterministic.** `Allow` headers get compared in tests and used as cache keys; a header that varies between requests for no reason is a nuisance. The handler in the error middleware then joins the array into a header value:

```
Allow: GET, OPTIONS, POST
```

**`OPTIONS` is added unconditionally**, because the CORS middleware answers every preflight before routing happens. Advertising `OPTIONS` here keeps the `Allow` header consistent with observable behaviour.

### The two 404s

The router throws `NotFoundError` for a path that matches nothing. A handler throws `NotFoundError` for a resource that does not exist. Both produce the same response.

That is deliberate. Telling an anonymous client "this URL pattern exists but that id does not" versus "this URL pattern does not exist" hands an attacker a map of your API for free. The distinction is valuable in your *logs*, and worthless to a stranger.

## 5. Capturing parameters

A segment starting with `:` captures whatever is at that position. Two details matter.

**Values are decoded.** `ctx.url.pathname` keeps percent-encoding intact, so a request for `/api/tasks/hello%20world` arrives with the literal text `hello%20world`. The handler almost certainly wants `hello world`, so:

```ts
params[name] = decodeURIComponent(pathSegment);
```

**Malformed escapes are the client's fault, so they get a 400:**

```ts
try {
  params[name] = decodeURIComponent(pathSegment);
} catch {
  throw new BadRequestError(
    `The URL contains an invalid percent-encoded escape sequence: "${pathSegment}".`,
  );
}
```

`decodeURIComponent` throws a `URIError` on input like `%zz` or a truncated `%e0`. That is a malformed request, not a server bug, and a bare `URIError` escaping upward would become a confusing 500.

Note that decoding happens *after* splitting on `/`. A segment like `%2F` decodes to a literal `/`, so `params.id` can contain a slash even though the path was split on them. For opaque ids that is harmless — a UUID never looks like that, and one that did would simply not be found.

## 6. Edge cases

| Case | Behaviour | Why |
|---|---|---|
| `/api/tasks` vs `/api/tasks/` | **Both match** | Empty segments are filtered out, so both produce `['api','tasks']`. Users type trailing slashes constantly. |
| `/api/Tasks` | **Does not match** `/api/tasks` | Comparison is case-sensitive, which is the safe default. Case-insensitivity makes two different URLs identical and gets confusing quickly. |
| `/api/tasks/42/notes` | **Does not match** `/api/tasks/:id` | Segment counts differ. Nothing is swallowed. |
| `/api/tasks//42` | **Matches**, with `id = '42'` | The empty segment from `//` is filtered out. Slightly permissive; harmless. |
| `/api/tasks/:id` and `/api/tasks/:taskId` | **Both match; first registered wins** | Routes are checked in registration order. |
| Two routes with the same method and path | **First registered wins**, silently | Not validated. See below. |
| Percent-encoded `/` (`%2F`) | Decodes into the captured value | Splitting happens before decoding. |
| Query string | Ignored by the router | `ctx.url.pathname` excludes it; handlers read `ctx.url.searchParams`. |

The "first registered wins" behaviour is worth being honest about, because it is a real sharp edge:

```ts
router.get('/api/tasks/:id', handlerA);
router.get('/api/tasks/count', handlerB);   // NEVER REACHED
```

`/api/tasks/count` matches `:id` first, so `handlerB` is dead code. The router does not detect this, because unlike a duplicate parameter name it is not always a mistake — but it is the reason most frameworks let you order routes deliberately, and the reason some (like Fastify, with its radix tree) are explicit about precedence rules.

## 7. What this router does not do

Being clear about the gaps is how you learn to evaluate a real one. What is missing, and what Express provides instead:

| Feature | This router | Express |
|---|---|---|
| `:param` captures | Yes | Yes |
| Wildcards (`/files/*`) | No | `*` and `/*splat` |
| Optional segments (`/:id?`) | No | Yes |
| Regex constraints (`/:id(\\d+)`) | No | Yes |
| Multi-segment parameters | No | `/:from-:to` |
| Route ordering / precedence rules | Registration order only | Registration order |
| Case-insensitive matching | No | `caseSensitive` option |
| Mounting a router at a prefix | No | `router.use('/api', sub)` |
| Automatic `HEAD` handling | No | Yes (delegates to `GET`) |
| `OPTIONS` per route | Handled globally by CORS | Per route |

Two consequences worth knowing:

**`HEAD` is not supported.** A `HEAD /health` request matches no route and gets a `405`. In practice `HEAD` is used for cache validation and link checking, and browsers rarely need it. Adding it properly means mapping `HEAD` to the `GET` handler and suppressing the body — which is genuinely fiddly, because you must still send the `Content-Length` the `GET` *would* have had, without actually sending the bytes.

**`OPTIONS` is answered globally, not per route.** `OPTIONS /api/nonexistent` returns `204` rather than `404`, because CORS handles every `OPTIONS` before the router runs. That is standard behaviour for permissive CORS, and worth knowing before it puzzles you.

## 8. Summarising Part 1

- A route is a method, a **pattern split into segments**, and a handler.
- Patterns are validated at registration, so mistakes fail at startup.
- Matching is a length check followed by a segment-by-segment walk, capturing `:` segments.
- `T | undefined` is the right return type for "matched or not" — and the right type for "found or not" everywhere else, too.
- **Path is matched before method**, because a correct `405` requires knowing what *would* have been allowed.
- `ctx.params` is a `Record<string, string>`, so parameter reads need `requireParam` to stay type-safe without `!`.

---

# Part 2: Middleware

## 9. The problem

Look at what a single handler has to do if there is no middleware:

```ts
async function createTask(ctx) {
  const startedAt = performance.now();
  try {
    if (ctx.method !== 'POST') { /* 405 ... */ }
    ctx.res.setHeader('Access-Control-Allow-Origin', '*');
    ctx.res.setHeader('Cache-Control', 'no-store');
    const body = await readJsonBody(ctx.req, maxBytes);
    const input = parseTaskWriteInput(body);
    const task = store.create(input);
    sendJson(ctx.res, 201, task);
  } catch (error) {
    /* turn the error into a response */
  } finally {
    console.log(`${ctx.method} ${ctx.url.pathname} ${ctx.res.statusCode} ${performance.now() - startedAt}ms`);
  }
}
```

Now multiply that by six endpoints, and then notice that the CORS line, the cache line, the `try`/`catch` and the logging are **identical** in all six. That is the duplication middleware exists to remove.

Rewrite it as six concerns:

```ts
async function createTask(ctx) {
  const body = await readJsonBody(ctx.req, maxBytes);
  const input = parseTaskWriteInput(body);
  const task = store.create(input);
  ctx.res.setHeader('Location', `/api/tasks/${task.id}`);
  sendJson(ctx.res, 201, task);
}
```

Four lines, and all eight lines of boilerplate are gone — not moved somewhere else in the handler, but genuinely handled once, for every endpoint, in `app.ts`.

The mechanism that makes this possible is the `next` function.

## 10. `next` is a closure, and that is the whole trick

Here is the entire composition engine:

```ts
export function compose(
  middlewares: readonly Middleware[],
): (ctx: RequestContext) => Promise<void> {
  return async function runPipeline(ctx: RequestContext): Promise<void> {
    let lastIndex = -1;

    async function dispatch(index: number): Promise<void> {
      if (index <= lastIndex) {
        throw new Error('next() was called more than once in a single middleware. ...');
      }
      lastIndex = index;

      const middleware = middlewares[index];
      if (middleware === undefined) {
        return;
      }

      const next: NextFunction = () => dispatch(index + 1);
      await middleware(ctx, next);
    }

    await dispatch(0);
  };
}
```

The important line is:

```ts
const next: NextFunction = () => dispatch(index + 1);
```

Ask yourself why `next` does not need to know *which* middleware called it. It does not, because `index` is a **parameter of the enclosing `dispatch` call**. Every invocation of `dispatch` gets its own `index`, and every `next` created inside it closes over that particular value.

So when `logger` calls `next()`, it is really calling `dispatch(1)` — position 1 in the array. When `errorHandler` calls `next()`, its own `next` was created inside `dispatch(1)`, so it calls `dispatch(2)`. Each middleware's `next` is a closure carrying its own position.

This is the same closure mechanism as:

```js
function makeCounter() {
  let count = 0;
  return () => ++count;
}
```

Just applied recursively. If closures are still fuzzy, that is the one concept worth revisiting before the rest of this chapter — nothing here will make sense without it.

### Why `lastIndex` is there

```ts
if (index <= lastIndex) {
  throw new Error('next() was called more than once in a single middleware. ...');
}
```

Call `next()` twice in one middleware and the rest of the chain runs twice — the handler executes twice, so two tasks get created from one request. This is a genuinely horrible bug to track down, because the request "works" and you just get duplicates.

Koa's implementation (which this mirrors) turns that into a loud immediate crash. The guard is cheap and it converts a data-corruption bug into a stack trace.

### Why the trailing `await middleware(ctx, next)` matters

```ts
await middleware(ctx, next);
```

That `await` is what makes code *after* `await next()` inside a middleware run only once everything downstream has finished. Without it, `dispatch` would return as soon as the middleware's synchronous prefix completed, and the "return path" of the onion would not exist.

## 11. The onion

With `await` in place, control flows down through the array and back up again:

```
                       ┌──────────────────────────────────────┐
   request ──────────▶ │ logger        startedAt = now()      │
                       │   ┌──────────────────────────────────┤
                       │   │ errorHandler   try {             │
                       │   │   ┌──────────────────────────────┤
                       │   │   │ defaultHeaders               │
                       │   │   │   ┌──────────────────────────┤
                       │   │   │   │ cors                     │
                       │   │   │   │   ┌──────────────────────┤
                       │   │   │   │   │ router -> handler    │
                       │   │   │   │   │   sendJson()         │
                       │   │   │   │   └──────────────────────┤
                       │   │   │   │ }  (nothing after next)  │
                       │   │   │   └──────────────────────────┤
                       │   │   │ }                            │
                       │   │   └──────────────────────────────┤
                       │   │ } catch { sendError() }          │
                       │   └──────────────────────────────────┤
                       │ } finally { log(status, elapsed) }   │
                       └──────────────────────────────────────┘
   response ◀─────────┘
```

Concretely, for `POST /api/tasks` with a valid body:

```
logger        : start clock
  errorHandler: try
    defaultHeaders: set Cache-Control, nosniff
      cors        : set Access-Control-Allow-Origin
        router    : match POST /api/tasks
          handler : read body, validate, store.create(), sendJson(201)
        router    : returns
      cors        : returns (its code after await next() — none — completes)
    defaultHeaders: returns
  errorHandler: try block completes with no exception
logger        : finally -> log "POST /api/tasks 201 1.4ms"
```

And for the same request with an empty title:

```
logger        : start clock
  errorHandler: try
    defaultHeaders: set headers
      cors        : set headers
        router    : match POST /api/tasks
          handler : read body
          handler : parseTaskWriteInput -> THROW UnprocessableEntityError
        router    : (does not catch) ✗
      cors        : (does not catch) ✗
    defaultHeaders: (does not catch) ✗
  errorHandler: catch -> toHttpError -> sendError(422)
logger        : finally -> log "POST /api/tasks 422 0.9ms"
```

The request travelled four levels down and only two levels back up. That is fine — the exception unwinds past everything that did not catch it, and only the error handler does.

## 12. Why the order is program structure

The array in `app.ts` is not a list of "things to do". It is a **nesting**, and nesting determines what each layer can rely on.

```ts
const middlewares: readonly Middleware[] = [
  createLogger({ ... }),        // 0: outermost
  createErrorHandler({ ... }),  // 1
  createDefaultHeaders(),       // 2
  createCors({ ... }),          // 3
  (ctx) => router.dispatch(ctx),// 4: innermost
];
```

Read it as: **each middleware can rely on everything inside it, and must cope with everything outside it.**

- The **error handler** is outside the router, so it can rely on the fact that anything the router or a handler throws will reach it. It never has to wonder whether some inner layer swallowed an exception.
- The **logger** is outside the error handler, so it can rely on the fact that when it regains control, the response is finished and `res.statusCode` is final.

### The swap that proves it

Reverse the first two entries:

```ts
const middlewares = [
  createErrorHandler({ ... }),  // now outermost
  createLogger({ ... }),
  // ...
];
```

Now trace a request that fails with a 422. The error handler calls `next()`, which enters the logger. The logger starts its clock and calls `next()`. The router runs, the handler throws, and the exception unwinds:

1. The **logger's** `finally` block runs first — it is the innermost of the two. At this moment `ctx.res.statusCode` is still Node's default, **`200`**, because the error handler has not caught anything yet.
2. The logger prints `POST /api/tasks 200 0.9ms`.
3. The exception continues to the error handler, which catches it and sends a `422`.

The client correctly receives a 422. **Your log says 200.** Every dashboard, every metric, every alert built on that log is now wrong, and the bug is invisible in testing because the response is right.

That is the whole point: middleware order is not a style preference, it is a correctness property of the program. When you add a middleware, the question is never just "what does it do?" but "what must it be outside of, and what must it be inside of?"

### A general rule for placing a middleware

| The middleware... | Put it... | Why |
|---|---|---|
| catches errors | outside everything it should catch | `try`/`catch` only covers what is lexically inside it |
| measures or logs the outcome | outside whatever sets the outcome | it needs the final status code |
| sets headers for every response | outside everything except the terminal handler | so it runs even on error paths |
| may reject the request | inside the header layers, outside the router | the client still needs CORS headers to read the 401 |
| authenticates | **inside CORS, outside the router** | a browser must be able to read the 401 |
| rates-limits | as far outside as possible | don't spend work on requests you'll refuse |
| parses a body | inside auth, where it's actually needed | skip the I/O for requests you reject |

That "inside CORS, outside the router" answer for authentication is worth remembering. Put auth outside CORS and a browser gets an unreadable network error instead of a clear `401 Unauthorized`, because the response lacks `Access-Control-Allow-Origin`.

## 13. Short-circuiting

A middleware does not have to call `next()`. If it responds itself and returns, the request never reaches anything inside it:

```ts
export function createCors(options: CorsOptions): Middleware {
  return async (ctx, next) => {
    const { res } = ctx;
    res.setHeader('Access-Control-Allow-Origin', options.origin);
    // ...

    if (ctx.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', options.methods.join(', '));
      res.setHeader('Access-Control-Allow-Headers', options.headers.join(', '));
      res.setHeader('Access-Control-Max-Age', '86400');
      res.setHeader('Allow', options.methods.join(', '));

      sendNoContent(res);
      return;   // <-- no next(): the router never runs
    }

    await next();
  };
}
```

This is the second half of the middleware contract, and the half people forget. Middleware can:

1. **Continue** — modify the context or the response, `await next()`, then do more work afterwards.
2. **Short-circuit** — respond and return without calling `next()`.

Preflight is the textbook short-circuit. An `OPTIONS` request is not asking for a resource, so there is nothing for the router to match; answering at the CORS layer is both necessary and cheaper.

`return` after responding is mandatory. Fall through to `await next()` and you will call `res.writeHead` a second time, which throws `ERR_HTTP_HEADERS_SENT`.

## 14. How errors travel

Notice what the middle layers do **not** contain: any `try`/`catch`.

```ts
export function createDefaultHeaders(): Middleware {
  return async (ctx, next) => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
    await next();          // if this throws, we do nothing about it
  };
}
```

That is entirely intentional and it is what keeps the design small. The exception propagates outward through every `await` until something catches it. Exactly one middleware does: `createErrorHandler`. So exactly one file in the project knows how to turn a failure into an HTTP response.

The payoff, stated as a rule you can apply in your own code:

> **A handler's job is to either produce a result or throw. It never decides a status code for a failure.**

Compare:

```ts
// Without the pattern: every handler does error plumbing.
router.get('/api/tasks/:id', async (ctx) => {
  const task = store.findById(requireParam(ctx, 'id'));
  if (task === undefined) {
    ctx.res.writeHead(404, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  sendJson(ctx.res, 200, task);
});
```

```ts
// With it: the handler expresses intent, and nothing else.
router.get('/api/tasks/:id', (ctx) => {
  const task = store.findById(requireParam(ctx, 'id'));
  if (task === undefined) {
    throw new NotFoundError(`No task exists with id "${requireParam(ctx, 'id')}".`);
  }
  sendJson(ctx.res, 200, task);
});
```

The second version is shorter, yes. More importantly it is *composable*: you could wrap it in a transaction middleware, or a caching middleware, and neither would need to know that a 404 is possible.

There is one wrinkle worth understanding, and the logger demonstrates it:

```ts
const startedAt = process.hrtime.bigint();
try {
  await next();
} finally {
  // log
}
```

`finally` runs whether the body completed normally or threw. But `catch` is absent, so the exception **keeps propagating** after the log line is written. A middleware can therefore observe a failure without handling it — and that is exactly what a logger should do. Observing is not handling.

## 15. How this compares to Express and Koa

| | This project | Express 5 | Koa |
|---|---|---|---|
| Middleware signature | `(ctx, next) => ...` | `(req, res, next) => ...` | `(ctx, next) => ...` |
| Context object | `ctx` bundles `req`, `res`, `url`, `params` | `req` and `res` passed separately | `ctx` with `ctx.request`/`ctx.response` |
| Advancing the chain | `await next()` | `next()` — **not** awaited | `await next()` |
| Code after `next()` runs | Yes, downstream first | Only for sync-style handlers; `next()` returns `undefined` | Yes |
| Error middleware | A normal middleware with `try`/`catch` | Special 4-arg `(err, req, res, next)`, registered last | A normal middleware with `try`/`catch` |
| Short-circuit | Respond and return | Respond and return | Respond and return |
| Call `next()` twice | Throws | Runs the chain twice | Throws |
| Async errors caught automatically | Yes | **Only in Express 5.** Express 4 needed `next(err)` or a wrapper | Yes |

The substantive difference is Express's **error middleware**. Express identifies it by arity — four parameters instead of three — and it must be registered last, after all your routes. This project (like Koa) has no special case: error handling is just a middleware whose body happens to be a `try`/`catch`, and it can sit anywhere you like in the chain. That is arguably the cleaner design, and it is why the middleware here can be freely reordered without special rules — the only thing you must think about is nesting.

The other difference to internalise: in Express 4, `next()` is not awaited, so a middleware could not reliably run code after the response was produced without extra work. If you have written Express middleware and wondered why `await next()` behaved oddly, that is why.

## 16. Writing your own middleware

The template, in full:

```ts
import type { Middleware } from '../types/http.ts';

export interface MyOptions {
  readonly something: string;
}

export function createMyMiddleware(options: MyOptions): Middleware {
  // Anything in this outer function is captured once, at wiring time.
  // Use it for configuration and for expensive setup.
  const prepared = options.something.toUpperCase();

  return async (ctx, next) => {
    // --- before the rest of the chain ---
    const startedAt = process.hrtime.bigint();

    try {
      await next();
    } catch (error: unknown) {
      // Only if you actually intend to handle it. If you are only observing,
      // log and re-throw -- or use `finally` and don't catch at all.
      throw error;
    } finally {
      // --- a place where BOTH outcomes converge ---
      const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // ...
    }

    // --- after the rest of the chain, only on the success path ---
    // (Note: unreachable if you re-throw above. Use `finally` for both paths.)
  };
}
```

Then register it in `app.ts`, **and think about where**:

```ts
const middlewares: readonly Middleware[] = [
  createLogger({ ... }),
  createErrorHandler({ ... }),
  createDefaultHeaders(),
  createMyMiddleware({ something: 'value' }),   // <-- where, and why?
  createCors({ ... }),
  (ctx) => router.dispatch(ctx),
];
```

The factory-function shape (an outer function taking options, returning the middleware) is used for all five middleware in this project, for three reasons:

1. It gives you somewhere to put configuration.
2. It gives you a scope for state that persists across requests — a rate-limit counter, for instance.
3. It means a middleware can be instantiated more than once with different configuration, like `createLogger({ enabled: false })` in tests.

One shortcut worth knowing: a middleware that needs no options does not need a factory.

```ts
// Either of these works.
router.get('/x', (ctx) => { /* ... */ });
const middleware: Middleware = (ctx, next) => next();
```

A function that ignores its second parameter is a perfectly good `Middleware`, which is why the router can be the last entry in the array without a wrapper worth naming.

## 17. Common mistakes

**Calling `next()` twice.** Throws here, silently runs the chain twice in Express. Both tasks get created.

**Forgetting to `await next()`.** The middleware's post-`next` code runs immediately, before the response — so it reads a stale `res.statusCode`, and any `try`/`catch` around it will not catch downstream errors, because the downstream work is still pending when the `try` block exits. This is the single most common async middleware bug.

**Falling through after responding.** If you short-circuit with `sendNoContent(res)` you must `return`, or `writeHead` gets called twice and throws `ERR_HTTP_HEADERS_SENT`.

**Assuming middleware runs concurrently.** It does not. Middleware is strictly sequential, one at a time, in order, on one thread. "Running in parallel" is never the case.

**Forgetting that the terminal handler is not special.** The router is just the last middleware. If you want to run something after every handler, you add a middleware *outside* the router — not code in each handler.

**Putting the logger where it cannot see the outcome.** As in §12: if the logger is inside the error handler, it logs `200` for failures.

**Swallowing errors in an empty `catch {}`.** The response is then never written and the client hangs until it times out, while your logs say nothing. If you catch, you must either handle it or re-throw it.

**Reaching for a global instead of a factory.** A module-level `let requestCount = 0` shared by every middleware instance makes tests order-dependent. Keep state in the factory's closure.

**Forgetting that `ctx.params` is shared and mutable.** `ctx.params` is assigned once by the router based on the matched route. A middleware running *before* the router will see `{}`, because matching has not happened yet.

## 18. Summarising Part 2

- Middleware removes per-endpoint boilerplate by wrapping handlers instead of being called by them.
- `compose` creates, for each position in the array, a `next` closure that knows its own index. That closure is the entire implementation.
- `await` on the middleware call is what produces the return path.
- Middleware may **continue** (`await next()`) or **short-circuit** (respond and return).
- Errors propagate outward until something catches them. Exactly one middleware in this project catches.
- **Order is nesting, and nesting determines what each layer can rely on.** Put the logger outside the error handler, or your logs will lie.
- Put authentication inside CORS and outside the router, so browsers can read the `401`.

---

**Next:** [06 — Errors and status codes](06-errors-and-status-codes.md) covers the error vocabulary that the middleware chain propagates, and gives you decision trees for choosing a status code.
