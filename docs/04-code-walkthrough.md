# 04 — Code walkthrough

This chapter walks the entire codebase, in the order the code actually runs. By the end you should be able to point at any file and say what it is for, why it exists separately from its neighbours, and what would break if you deleted it.

If you have not read [chapter 01](01-http-and-rest-fundamentals.md) yet, read it first. This chapter assumes you know what a status code and a header are.

**How to read this chapter.** Sections 1–4 follow one request from the socket to the response, twice: once for a request that fails and once for one that succeeds. Those two traces are the fastest way to understand the whole design. Section 5 onwards is the file-by-file reference; dip into it rather than reading it end to end.

---

## Contents

1. [The shape of the codebase](#1-the-shape-of-the-codebase)
2. [What happens when you start the server](#2-what-happens-when-you-start-the-server)
3. [Trace: a request that fails](#3-trace-a-request-that-fails)
4. [Trace: a request that succeeds](#4-trace-a-request-that-succeeds)
5. [The files, one by one](#5-the-files-one-by-one)
6. [The layering rules](#6-the-layering-rules)
7. [Recipes: where to change what](#7-recipes-where-to-change-what)

---

## 1. The shape of the codebase

Twenty source files. Here they are grouped by what they know about:

```
                        ┌──────────────────────────────┐
                        │  server.ts                   │  knows about ports,
                        │  "start a server and stop    │  signals and the OS
                        │   it cleanly"                │
                        └──────────────┬───────────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │  app.ts                      │  knows how the pieces
                        │  "wire everything together"  │  fit together
                        └──────────────┬───────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
┌───────▼────────┐          ┌──────────▼─────────┐          ┌─────────▼────────┐
│  routes/       │          │  middleware/       │          │  data/           │
│  tasks         │          │  logger            │          │  task.store      │
│  health        │          │  errorHandler      │          │  seed            │
│  "what does    │          │  cors              │          │  "how tasks are  │
│   each URL     │          │  defaultHeaders    │          │   kept"          │
│   mean?"       │          │  compose           │          │                  │
└───────┬────────┘          └──────────┬─────────┘          └─────────┬────────┘
        │                              │                              │
        └──────────────────────────────┼──────────────────────────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │  http/ + router.ts +         │  knows about HTTP as a
                        │  validation/ + types/        │  protocol, not about
                        │  "the vocabulary everything  │  tasks or ports
                        │   else speaks in"            │
                        └──────────────────────────────┘
```

The important property is the **direction of the arrows**. Dependencies point one way only:

- `routes/` may import from `http/`, `validation/`, `data/` and `types/`.
- `data/task.store.ts` imports **only** from `types/`. It has no idea HTTP exists.
- `validation/` imports from `http/errors.ts` and `types/` — it produces errors, but it has never seen a request object.
- `http/` imports from `types/` and Node built-ins. It knows nothing about tasks.
- Nothing imports `server.ts`.

That is what makes `data/` swappable: when you replace the in-memory `Map` with SQLite in [chapter 08](08-next-steps.md), not one route handler changes, because no route handler has ever known how tasks are stored.

---

## 2. What happens when you start the server

You run:

```bash
npm run dev
```

which is:

```bash
node --watch --env-file-if-exists=.env src/server.ts
```

### Step 1 — Node reads the flag and the file

`--env-file-if-exists=.env` loads `.env` into `process.env` if the file is there, and stays quiet if it is not. That is the whole of what `dotenv` would do for you, built in.

Then Node loads `src/server.ts`. Because the file ends in `.ts` and Node 24 supports type stripping, Node's loader **erases every type annotation** and executes the JavaScript that remains. No build step, no cache directory, no `ts-node`.

Two things follow from that, and both are covered properly in [chapter 02](02-typescript-for-javascript-developers.md):

- Types are **erased**, not checked. A file with type errors still runs.
- Only *erasable* syntax is allowed: no `enum`, no `namespace` with runtime contents, no constructor parameter properties.

### Step 2 — The module graph is evaluated, once

`server.ts` starts with imports:

```ts
import { createServer } from 'node:http';
import { buildApp } from './app.ts';
import { config } from './config.ts';
```

Node resolves and evaluates imports **depth-first, before the importing module's own body runs**. So evaluating `app.ts` pulls in its imports first:

```
server.ts
└── app.ts
    ├── config.ts            <-- evaluated here, once
    ├── data/task.store.ts
    ├── data/seed.ts
    ├── http/context.ts
    ├── http/response.ts
    ├── middleware/compose.ts
    ├── middleware/cors.ts
    ├── middleware/defaultHeaders.ts
    ├── middleware/errorHandler.ts
    ├── middleware/logger.ts
    ├── router.ts
    ├── routes/health.routes.ts
    └── routes/tasks.routes.ts
```

`config.ts` has module-level statements that read and validate `process.env`:

```ts
export const config: AppConfig = {
  nodeEnv: readString('NODE_ENV', 'development'),
  host: readString('HOST', '127.0.0.1'),
  port: readInteger('PORT', 3000, 0, 65_535),
  // ...
};
```

Because Node caches a module after evaluating it once, this object is built **exactly once per process**, and every file that imports `config` gets the same object. That is why an invalid `PORT` produces its error before any server starts — and why you cannot change configuration from inside a request handler.

### Step 3 — `buildApp()` assembles everything

Back in `server.ts`:

```ts
const app = buildApp();
```

`buildApp()` in `app.ts` does four things in order.

**a. Create the store, and optionally seed it.**

```ts
const store = new TaskStore();
if (options.seed ?? config.seedData) {
  store.seed(sampleTasks);
}
```

`new TaskStore()` creates an empty `Map`. `seed()` then calls `create()` four times — the *same* `create()` that `POST /api/tasks` uses. There is deliberately no second path that can make a task.

**b. Create the router and register routes.**

```ts
const router = new Router();
registerHealthRoutes(router);
registerTaskRoutes(router, { store, maxBodyBytes: options.maxBodyBytes ?? config.maxBodyBytes });
```

Note that `registerTaskRoutes` receives the store as an argument rather than importing a global. This is dependency injection, and its practical payoff is testability: `tests/helpers/testServer.ts` builds an app with its own store and its own limits, so tests never interfere with each other.

Route registration is also where path patterns are validated. `router.add()` throws immediately if a pattern is malformed or reuses a parameter name — a configuration mistake should crash at startup, when the fix is obvious, not surface as a mysterious runtime failure.

**c. Compose the middleware pipeline.**

```ts
const middlewares: readonly Middleware[] = [
  createLogger({ enabled: options.logRequests ?? config.logRequests }),
  createErrorHandler({ exposeInternalErrors: config.nodeEnv !== 'production' }),
  createDefaultHeaders(),
  createCors({ origin: ..., methods: ALLOWED_METHODS, headers: ALLOWED_HEADERS }),
  (ctx) => router.dispatch(ctx),
];

const pipeline = compose(middlewares);
```

Read that array as a set of nested boxes:

```
logger (
  errorHandler (
    defaultHeaders (
      cors (
        router
      )
    )
  )
)
```

The router is *inside* everything. That is what lets the error handler catch anything the router or a handler throws, and what lets the logger measure the complete request including its error path.

**d. Build the Node request listener.**

```ts
const listener: RequestListener = (req, res) => {
  const ctx = createRequestContext(req, res);
  pipeline(ctx).catch((error: unknown) => { /* last resort */ });
};
```

Two things worth noticing.

`ctx` is built here, once, and travels through every middleware and into the handler. Node hands you two bare objects; this bundles them with the parsed URL and a place for route parameters.

And `pipeline(ctx)` returns a promise that **Node will not await**. Node's request listener is synchronous as far as Node is concerned — it only cares that the response eventually gets written. So *we* must handle rejection. An unhandled promise rejection terminates the Node process by default, which would mean a single malformed request could take down the server. That `.catch()` is the last line of defence. It should be unreachable, because the error handler sits inside the pipeline — but "should be unreachable" is not a security model.

### Step 4 — `createServer` and `listen`

```ts
const server = createServer(app.listener);
```

`createServer` wraps the listener in an HTTP server but **binds nothing yet**. No port is open.

```ts
server.listen(config.port, config.host, () => { /* print the banner */ });
```

`listen` is asynchronous. The callback fires once the OS has actually bound the port, which is why the banner is printed there rather than after the call. Printing it earlier would be a lie whenever the port is unavailable.

Binding can fail, and the failure arrives as an `error` event rather than a thrown exception:

```ts
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') { /* friendly message */ }
  // ...
});
```

The callback reads the bound port back from `server.address()` rather than trusting `config.port`, because port `0` means "OS, pick one" and you would otherwise have no idea which port you got. The tests rely on exactly this.

### Step 5 — Signal handlers are registered

```ts
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

Registering a handler does not block anything; it just means that when the signal arrives, `shutdown` runs instead of the default immediate termination. See [§5.19](#519-srcserverts) for what `shutdown` does and why it needs three different Node APIs.

**The server is now running and idle.** Nothing has happened yet. Let us send it a request.

---

## 3. Trace: a request that fails

```bash
curl.exe -i -X POST http://127.0.0.1:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"\"}"
```

An empty title. This should be a 422.

### 1. The OS and Node accept the connection

The kernel accepts the TCP connection and hands the bytes to Node. Node's HTTP parser (a C library called `llhttp`) reads them and decides it has a complete request: a request line, headers, and a body of a known length.

Only now does Node construct the two objects and call our listener:

```ts
const listener: RequestListener = (req, res) => { ... };
```

At this point:

- `req.method === 'POST'`
- `req.url === '/api/tasks'` — the request *target*, not a full URL
- `req.headers['content-type'] === 'application/json'`
- The body has **not** been read. `req` is a `Readable` stream, and those 18 bytes are sitting in a socket buffer.

### 2. `createRequestContext` runs

```ts
export function createRequestContext(req, res): RequestContext {
  const host = req.headers.host ?? 'localhost';
  const target = req.url ?? '/';

  return {
    req, res,
    method: req.method ?? 'GET',
    url: new URL(target, `http://${host}`),
    params: {},
  };
}
```

`req.url` is only `/api/tasks`, which is not a valid URL on its own. HTTP gives us the missing piece in the `Host` header, so `new URL('/api/tasks', 'http://127.0.0.1:3000')` produces a fully parsed URL with `.pathname` and `.searchParams` ready to use. Using the platform's `URL` class means percent-decoding and query parsing are correct without us writing any of it.

`params` starts empty. The router will fill it in.

### 3. `pipeline(ctx)` is called

`compose` returns a driver that runs each middleware in turn, passing a `next` closure that resumes further down the list.

**Middleware 1: logger.**

```ts
const startedAt = process.hrtime.bigint();
try {
  await next();
} finally {
  // ... log, using ctx.res.statusCode
}
```

The clock starts. `hrtime.bigint()` reads a *monotonic* clock, which only ever moves forward, unlike `Date.now()` — the system clock can be adjusted backwards mid-request by NTP or a daylight-saving change, and a negative duration in your logs is a genuinely confusing thing to debug.

Then it calls `await next()`, which hands control to the error handler.

**Middleware 2: errorHandler.**

```ts
return async (ctx, next) => {
  try {
    await next();
  } catch (error: unknown) {
    // ...
  }
};
```

It wraps everything below it in a `try`. Note the parameter type: `error: unknown`. Under `strict` mode TypeScript types caught values as `unknown`, because JavaScript lets you `throw` literally anything — a string, a number, `undefined`. Nothing here assumes it is an `Error`; that assumption is made later, deliberately, inside `toHttpError`.

**Middleware 3: defaultHeaders.**

```ts
ctx.res.setHeader('Cache-Control', 'no-store');
ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
await next();
```

`res.setHeader` writes into an internal header map. Nothing is sent yet. These will survive all the way to the final response — see step 8.

**Middleware 4: cors.**

```ts
res.setHeader('Access-Control-Allow-Origin', options.origin);
if (options.origin !== '*') {
  res.setHeader('Vary', 'Origin');
}
if (ctx.method === 'OPTIONS') {
  // ... answer the preflight and return without calling next()
}
await next();
```

The method is `POST`, not `OPTIONS`, so it does not short-circuit. It sets its headers and forwards.

**Middleware 5: the router.**

```ts
async dispatch(ctx: RequestContext): Promise<void> {
  const pathSegments = splitPath(ctx.url.pathname);   // ['api', 'tasks']
  // ... collect every route whose PATH matches
  // ... then find one whose METHOD matches
  ctx.params = match.params;
  await methodMatch.route.handler(ctx);
}
```

Two phases, and the order matters. `/api/tasks` matches a `GET` route and a `POST` route. Only after collecting both does the router look for the method. That two-phase approach is what makes a correct `405 Method Not Allowed` possible later — to answer "PATCH is not allowed here" you must first know that other methods *are* allowed.

`POST` is found. `params` is `{}` (no `:param` segments). The handler is called.

### 4. The handler runs and reads the body

```ts
router.post('/api/tasks', async (ctx) => {
  const body = await readJsonBody(ctx.req, maxBodyBytes);
  const input = parseTaskWriteInput(body);
  const task = store.create(input);
  ctx.res.setHeader('Location', `/api/tasks/${task.id}`);
  sendJson(ctx.res, 201, task);
});
```

`readJsonBody` calls `readRawBody`, which collects the stream:

```ts
for await (const chunk of req) {
  const buffer = chunk as Buffer;
  receivedBytes += buffer.byteLength;
  if (receivedBytes > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }
  chunks.push(buffer);
}
return Buffer.concat(chunks).toString('utf8');
```

There is no `req.body` in Node. This is what `req.body` is in Express: a loop just like this one. The loop uses the async iterator protocol, which applies backpressure for us — it pauses the socket between iterations rather than reading megabytes into memory as fast as they arrive.

Two details that matter more than they look:

- We count **bytes**, not characters. `'é'.length` is 1, but it is 2 bytes in UTF-8.
- We concatenate `Buffer`s and decode **once at the end**, rather than decoding each chunk. A multi-byte UTF-8 character can straddle a chunk boundary, and decoding chunk-by-chunk would corrupt it.

Then:

```ts
const parsed: unknown = JSON.parse(raw);
return parsed;
```

`JSON.parse` is typed `any` by TypeScript, which would switch off checking for every value it touches. Annotating the variable as `unknown` keeps the value opaque, so the compiler insists that somebody proves what it is before using it. That somebody is the validator.

The body is `{"title":""}`, so `readJsonBody` returns the object successfully. **We are now past the trust boundary's first gate.**

### 5. The validator rejects it

```ts
export function parseTaskWriteInput(body: unknown): TaskWriteInput {
  const raw = requireJsonObject(body);
  const collector = new FieldCollector();

  rejectUnknownFields(raw, collector);

  const title = readTitle(raw, collector, true);
  // ...

  if (title === undefined || !collector.ok) {
    throw new UnprocessableEntityError('The request body failed validation.', collector.issues);
  }
  // ...
}
```

`readTitle` finds an empty string after trimming and records the problem instead of throwing:

```ts
if (trimmed.length === 0) {
  collector.add('title', 'Must not be empty or whitespace only.');
  return undefined;
}
```

Collecting issues rather than failing on the first one is a deliberate choice. A client with three mistakes gets told about all three at once instead of playing whack-a-mole one request at a time.

`collector.ok` is now `false`, so the function throws:

```ts
throw new UnprocessableEntityError('The request body failed validation.', collector.issues);
```

That is a plain `throw` from a plain function. **There is no HTTP in this file at all** — no status code, no response object, no `res`. The validator knows what went wrong; it does not know, or care, how the caller will tell the client.

### 6. The stack unwinds through the onion

The `throw` propagates upward. The router does not catch it. `cors` does not catch it. `defaultHeaders` does not catch it.

It arrives at the error handler's `catch`:

```ts
} catch (error: unknown) {
  const httpError = toHttpError(error, exposeInternalErrors);

  if (httpError.status >= 500 && logServerErrors) {
    console.error(`[error] ${ctx.method} ${ctx.url.pathname} failed:`, error);
  }

  if (ctx.res.headersSent) {
    ctx.res.destroy();
    return;
  }

  const extraHeaders: Record<string, string> =
    httpError instanceof MethodNotAllowedError
      ? { Allow: httpError.allowed.join(', ') }
      : {};

  sendError(ctx.res, httpError, extraHeaders);
}
```

`toHttpError` asks `error instanceof HttpError`. It is, so it passes straight through — our deliberate errors are already in the right shape:

```ts
if (error instanceof HttpError) {
  return error;
}
```

The status is 422, so nothing is logged here. Client errors are normal traffic and already show up in the access log; only 5xx gets a stack trace printed.

`ctx.res.headersSent` is `false` — `setHeader` does not send anything, only `writeHead` and `end` do. So we skip the `destroy()` branch.

There is no `Allow` header to set for a 422. Then:

```ts
export function sendError(res, error, extraHeaders = {}) {
  const envelope = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  sendJson(res, error.status, envelope, extraHeaders);
}
```

### 7. The response is written

```ts
export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  const bytes = Buffer.from(payload, 'utf8');

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes.byteLength),
    ...headers,
  });
  res.end(bytes);
}
```

`Content-Length` is computed from `bytes.byteLength`, not `payload.length`. They differ for any non-ASCII character, and getting this wrong means the client either hangs waiting for bytes that never come or truncates the body.

`res.writeHead` **merges** the headers set earlier via `setHeader` with the object passed here, and the object wins on conflicts. That is why the `Cache-Control`, `X-Content-Type-Options` and `Access-Control-Allow-Origin` headers from steps 3 and 4 appear on this error response even though no handler ever mentioned them. It is also why a browser can read a `422` at all — without `Access-Control-Allow-Origin`, CORS would hide the response body and turn a clear validation error into an opaque network failure in the console.

`res.end(bytes)` flushes everything and ends the response.

### 8. The error handler returns, and the logger logs

`sendError` returns normally. The error handler's function body ends. So `await next()` inside... wait — no. The exception unwound past `await next()`. The error handler caught it, handled it, and its `async` function now **resolves** normally.

That resolution propagates to the logger's `await next()`, which is inside a `try`/`finally`:

```ts
} finally {
  const status = ctx.res.statusCode;
  const colour = colourForStatus(status);
  console.log(`${time} ${ctx.method.padEnd(6)} ${target} ${colour}${status}${RESET} ${elapsedMs.toFixed(1)}ms`);
}
```

`finally` runs on **both** the success and failure paths. And because the error handler has already written the response, `ctx.res.statusCode` is the real `422`, not the `200` that `ServerResponse` defaults to.

> **This is why the logger must be outside the error handler.** Swap those two entries in the middleware array and the logger would read `res.statusCode` before the error handler had set it — every failed request would be logged as `200`, and you would be debugging from a log file that lies to you.

The log line is:

```
19:41:02.113 POST   /api/tasks 422 0.9ms
```

### 9. The client sees

```
HTTP/1.1 422 Unprocessable Entity
Cache-Control: no-store
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 143

{"error":{"code":"VALIDATION_FAILED","message":"The request body failed validation.","details":[{"field":"title","message":"Must not be empty or whitespace only."}]}}
```

---

## 4. Trace: a request that succeeds

Same endpoint, valid body:

```bash
curl.exe -i -X POST http://127.0.0.1:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"  Read the docs  \",\"priority\":\"high\"}"
```

Steps 1–4 are identical: the connection is accepted, the context is built, the onion is entered, the router matches, and the handler reads the body. The divergence happens in the validator.

**`requireJsonObject` succeeds.** The three checks all pass:

```ts
if (typeof body !== 'object' || body === null || Array.isArray(body)) { /* reject */ }
return body as Record<string, unknown>;
```

Each check is necessary. `typeof` rejects strings, numbers, booleans and `undefined`. `=== null` is required because `typeof null === 'object'` — one of JavaScript's most famous historical quirks. `Array.isArray` rejects arrays, which are objects and would otherwise pass. Note that all three are needed: `JSON.parse('"hello"')` succeeds and returns a string, and `JSON.parse('[1,2,3]')` succeeds and returns an array.

The `as Record<string, unknown>` at the end is the *"validate, then assert"* pattern. We have just proved at runtime that this is a non-null, non-array object, so telling the compiler so is honest — unlike a bare `as` with no check behind it, which is just wishing.

**`readTitle` returns `"Read the docs"`.** It trims, checks the length is between 1 and 200, and returns the trimmed value. Normalising here means `"  Read the docs  "` and `"Read the docs"` can never both end up in the store as different values.

**`readDescription` returns `undefined`.** The field was absent, and on a full write that means "use the default".

**`readPriority` returns `"high"`.** This is where the type guard earns its keep:

```ts
function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && isOneOf(TASK_PRIORITIES, value);
}
```

The `value is TaskPriority` return type is a *type predicate* — a promise to the compiler that a `true` result means `value` can be narrowed. So inside this branch, `value` is a `TaskPriority` with no cast:

```ts
if (isTaskPriority(value)) {
  return value;   // value is 'low' | 'medium' | 'high' here
}
```

**The function returns a fully populated value.**

```ts
return {
  title,
  description: description ?? null,
  priority: priority ?? DEFAULT_PRIORITY,
  completed: completed ?? false,
};
```

Every optional field now has a concrete value. Past this line, nothing downstream ever has to ask "what if `priority` is missing?" — it cannot be. That is the whole point of normalising at the boundary. The input was a loose, untrusted `unknown`; the output is a `TaskWriteInput` whose every field is present and correct.

Note `??` rather than `||`. `??` supplies the default only for `null` and `undefined`, so a real `false` for `completed` survives. With `||`, `completed: false` would be falsy and would be replaced by the default — the classic `??` versus `||` trap.

**The store creates the task.**

```ts
create(input: TaskWriteInput): Task {
  const now = new Date().toISOString();

  const task: Task = {
    id: randomUUID(),
    title: input.title,
    description: input.description,
    priority: input.priority,
    completed: input.completed,
    createdAt: now,
    updatedAt: now,
  };

  this.#tasks.set(task.id, task);
  return task;
}
```

`randomUUID()` comes from `node:crypto`, so there is no `uuid` package. Ids are generated on the server, because the server owns the identity of its resources — a client must not be able to claim an id that is already taken.

Both timestamps are the same on creation and only diverge on update. That is what lets a client distinguish "created a while ago" from "changed recently". `toISOString()` produces UTC with a trailing `Z`; store and transmit UTC, and convert to local time only for display.

`#tasks` is a JavaScript private field, not TypeScript's `private` keyword. `private` is erased along with the types and offers no runtime protection at all; `#` is enforced by the engine.

**The handler sets `Location` and responds.**

```ts
ctx.res.setHeader('Location', `/api/tasks/${task.id}`);
sendJson(ctx.res, 201, task);
```

`201 Created`, not `200`, because a new resource now exists at a URL that did not exist before. The `Location` header names that URL, so a client never has to construct it — which means you can change your URL scheme later without breaking well-behaved clients. The body is the full created task, *including* the server-generated id, timestamps and applied defaults, which saves the client a follow-up `GET` and removes any ambiguity about what was actually stored.

**The onion unwinds cleanly.** `sendJson` returns, the handler resolves, `dispatch` resolves, `cors` resolves (its code after `await next()` — there is none — completes), `defaultHeaders` resolves, the error handler's `try` completes with no exception, and the logger's `finally` runs:

```
19:41:09.482 POST   /api/tasks 201 1.4ms
```

**The client sees:**

```
HTTP/1.1 201 Created
Cache-Control: no-store
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *
Location: /api/tasks/2164807c-1594-4d83-85a1-16b39c5f5b5b
Content-Type: application/json; charset=utf-8
Content-Length: 203

{"id":"2164807c-1594-4d83-85a1-16b39c5f5b5b","title":"Read the docs","description":null,"priority":"high","completed":false,"createdAt":"2026-10-16T19:33:07.262Z","updatedAt":"2026-10-16T19:33:07.262Z"}
```

That is the entire life of a request. Everything else in the codebase is a variation on it.

---

## 5. The files, one by one

### 5.1 `src/config.ts`

**Reads and validates `process.env` exactly once, at import time.**

The reason this is a separate file rather than scattered `process.env.X` reads is that `process.env` values are *always strings* and may be absent. Reading them in one place means converting them to their real types in one place, so the rest of the codebase has `port: number` instead of `port: string` and does not have to handle `undefined` at every use site.

Three details worth copying:

- `readInteger` uses `Number(raw)` rather than `parseInt(raw)`. `parseInt('3000abc')` cheerfully returns `3000`, which hides the typo; `Number('3000abc')` returns `NaN`.
- `readBoolean` accepts only the values people actually type (`true/false/1/0/yes/no`) and **throws** on anything else. Silently falling back to a default when someone writes `LOG_REQUESTS=yes` is exactly the kind of quiet surprise that wastes an afternoon.
- An empty string is treated as "not set". `PORT=` in a `.env` file almost always means "I did not set this", not "use the empty string".

The exported object is a single frozen-by-convention `AppConfig`, with every field `readonly`. Configuration is decided at startup and nothing should be able to change it halfway through a request.

### 5.2 `src/types/task.ts`

**The task domain, expressed as types.**

Most of this file vanishes at runtime. Two things survive, and they are what make the file more than documentation:

```ts
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
```

`as const` stops the array from widening to `string[]` and makes it readonly, so it stays a tuple of the three exact literals. Then `(typeof TASK_PRIORITIES)[number]` reads as "the type of one element of that array", which is the union `'low' | 'medium' | 'high'`.

Defining the *type* from the *runtime value* — rather than writing both and hoping they stay in sync — is the idiomatic TypeScript replacement for an `enum`, and it means adding a priority to the array updates the type automatically. `enum` cannot be used here anyway: it generates runtime code, so it is not erasable. See [chapter 02](02-typescript-for-javascript-developers.md).

The three input types encode three different intentions:

| Type | Used by | Meaning |
|---|---|---|
| `Task` | responses, the store | The complete stored resource, including server-generated `id` and timestamps. Every field `readonly`. |
| `TaskWriteInput` | `POST`, `PUT` | A complete replacement state. Every field present — the validator fills defaults, so nothing downstream deals with optionality. |
| `TaskUpdateInput` | `PATCH` | Every field optional. An absent field means "leave it alone". |

`createdAt` and `updatedAt` are `string`, not `Date`. JSON has no date type, so timestamps travel as strings; keeping the domain type as a string avoids a confusing round trip where a `Date` silently becomes a string the moment it is serialized.

`description` is `string | null` rather than optional, because `null` is the explicit "there is no description" value and is meaningfully different from "the field was absent from this request".

### 5.3 `src/types/http.ts`

**The vocabulary the HTTP layer speaks.** Four types, no runtime code at all.

`HttpMethod` is a hand-written union rather than `string`, so `router.add('DELETE ', ...)` with a stray space is a compile error instead of a route that silently never matches.

`RequestContext` is the single object that travels through the whole pipeline: the raw `req` and `res`, the method, the parsed `URL`, and `params`. Everything except `params` is `readonly`, because it is fixed for the request's lifetime; `params` is not, because the router only learns the values after matching.

`RouteHandler` returns `Promise<void> | void`, which lets a handler be `async` when it needs to read a body and plain synchronous when it does not. `await` on a non-promise value simply yields that value, so the router can `await` either form. Note that a handler does not *return* a response; it **writes** one into `ctx.res`. That is a Node-level detail leaking through, but it is the truth of the model.

`Middleware` is `(ctx, next) => Promise<void> | void` — the same shape as Koa. A middleware either calls `await next()` and lets the request continue, or responds itself and returns without calling `next()`.

### 5.4 `src/http/errors.ts`

**The error vocabulary.** One base class and seven subclasses, one per status code.

```ts
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
```

Two things to notice.

**The fields are declared and then assigned in the constructor.** TypeScript has a shorthand for exactly this — a *parameter property*, `constructor(readonly status: number)` — and it cannot be used here, because it *generates* assignment code rather than merely annotating existing code. That makes it impossible for Node to strip, and `erasableSyntaxOnly` in the tsconfig rejects it. This constructor is what the shorthand would have expanded to.

**`this.name = new.target.name`** gives each subclass a useful `name`. Without it every subclass would report `name === 'Error'` and your logs would say `Error: ...` for everything. `new.target` is plain JavaScript: it refers to the constructor actually invoked with `new`, so a `BadRequestError` reports `'BadRequestError'`.

The subclasses are thin — each exists to attach a status code and a `code` string to a meaningful name:

| Class | Status | `code` |
|---|---|---|
| `BadRequestError` | 400 | `BAD_REQUEST` |
| `NotFoundError` | 404 | `NOT_FOUND` |
| `MethodNotAllowedError` | 405 | `METHOD_NOT_ALLOWED` |
| `PayloadTooLargeError` | 413 | `PAYLOAD_TOO_LARGE` |
| `UnsupportedMediaTypeError` | 415 | `UNSUPPORTED_MEDIA_TYPE` |
| `UnprocessableEntityError` | 422 | `VALIDATION_FAILED` |
| `InternalServerError` | 500 | `INTERNAL_ERROR` |

`MethodNotAllowedError` carries extra state — `allowed: readonly string[]` — which the error handler turns into the `Allow` response header. That a *thrown error* can influence a response *header* is a good argument for the error handler having access to the whole context.

→ Every failure mode, in one table: [chapter 06](06-errors-and-status-codes.md).

### 5.5 `src/http/response.ts`

**Three functions, and every response in the API goes through one of them.**

`sendJson` is where the response is actually committed:

```ts
const payload = JSON.stringify(body);
const bytes = Buffer.from(payload, 'utf8');

res.writeHead(status, {
  'Content-Type': 'application/json; charset=utf-8',
  'Content-Length': String(bytes.byteLength),
  ...headers,
});
res.end(bytes);
```

- `charset=utf-8` matters more than people expect. JSON is always UTF-8 by specification, but some HTTP clients still guess Latin-1 when no charset is declared, and then your accented characters arrive mangled.
- `Buffer.byteLength` is a **byte** count, and `payload.length` is a **character** count. They differ for any non-ASCII character, and declaring the wrong one makes the client hang or truncate.
- The header object passed to `writeHead` does not replace headers set earlier with `setHeader`; Node merges them, with this object winning on conflicts. That is the mechanism behind the CORS headers surviving onto error responses.

`sendNoContent` writes a bare `204` with no body and **no `Content-Length`** — a 204 must not have a body, and declaring a length for one is a protocol violation.

`sendError` builds the error envelope. The conditional spread is what makes `details` present only when there are some:

```ts
...(error.details === undefined ? {} : { details: error.details }),
```

### 5.6 `src/http/request.ts`

**Reads and parses the request body.**

The headline is that Node gives you no `req.body`. `req` is a `Readable` stream, and some code has to collect the chunks. In Express that code is the `body-parser` middleware; here it is `readRawBody`, about twenty lines.

`readRawBody` enforces the size limit **twice**, and both are needed:

- First from the announced `Content-Length`, so an oversized body is rejected before a single byte is transferred.
- Then while streaming, because a client is free to omit the header (using chunked transfer encoding) or simply lie about it.

That limit is not a nicety. A server that buffers an unbounded body will happily read a 10 GB request into memory and fall over. This is a real class of denial-of-service attack.

`readJsonBody` then applies checks in a deliberate order, chosen so the client gets the most useful message:

| Condition | Status |
|---|---|
| Empty body | `400` — there was nothing to parse |
| Missing or non-JSON `Content-Type` | `415` — we cannot read this format |
| Malformed JSON | `400` — a syntax problem |
| Valid JSON, unacceptable contents | `422` — handled by the validator, not here |

The media type check accepts structured-syntax JSON types too:

```ts
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json$/;
```

so `application/json`, `application/vnd.api+json` and `application/ld+json` all pass. Rejecting those would be needlessly strict; they *are* JSON. The header is cut at the first `;` so a `charset` parameter does not break the match.

### 5.7 `src/http/context.ts`

**Builds the per-request context, and reads route parameters safely.**

`createRequestContext` explains the one non-obvious thing: `req.url` is a request *target*, not a URL, so it needs the `Host` header as a base before `new URL` will accept it.

`requireParam` exists because of a genuine friction point. Handlers "know" that `/api/tasks/:id` populates `params.id`, but TypeScript does not — `params` is a `Record<string, string>`, so `params['id']` is `string | undefined`. Rather than sprinkling `!` non-null assertions through the routes, this turns the awkwardness into one clear failure:

```ts
export function requireParam(ctx: RequestContext, name: string): string {
  const value = ctx.params[name];
  if (value === undefined) {
    throw new InternalServerError(`Route parameter "${name}" is missing. ...`);
  }
  return value;
}
```

Note that this throws a **500**, not a 400. If it ever fires, the bug is in our route registration — a handler attached to a pattern that has no such parameter — not in the client's request.

### 5.8 `src/router.ts`

**Matches a method and path to a handler.** Roughly 150 lines, and it is the piece that makes `router.get('/x', fn)` stop feeling like magic.

Routes are stored pre-split, so `'/api/tasks/:id'` becomes `['api', 'tasks', ':id']`. Matching compares segment counts, treats a leading `:` as a capture, and compares everything else literally. Empty segments are filtered out, which is why a trailing slash is harmless.

`dispatch` collects **all** path matches before considering the method. That is what makes a correct `405` possible, and it also means the `Allow` header can list exactly the methods that exist.

→ Full explanation, including edge cases and how Express differs: [chapter 05](05-routing-and-middleware.md).

### 5.9 `src/middleware/compose.ts`

**Turns an array of middleware into one function.** About thirty lines, and it is the mechanism behind every middleware system in Node.

```ts
export function compose(middlewares) {
  return async function runPipeline(ctx) {
    let lastIndex = -1;

    async function dispatch(index: number): Promise<void> {
      if (index <= lastIndex) {
        throw new Error('next() was called more than once in a single middleware. ...');
      }
      lastIndex = index;

      const middleware = middlewares[index];
      if (middleware === undefined) return;

      const next: NextFunction = () => dispatch(index + 1);
      await middleware(ctx, next);
    }

    await dispatch(0);
  };
}
```

The trick is entirely in `const next = () => dispatch(index + 1)`. Because `index` is a parameter of the enclosing call, each `next` has its own captured value and always resumes at the *following* middleware — no matter how deeply nested the calls become. That closure is the whole implementation.

The `lastIndex` bookkeeping is Koa's standard guard. `next()` must be callable at most once per middleware; calling it twice would re-run the rest of the chain, which is almost always a bug and produces baffling behaviour. So it throws instead.

### 5.10 `src/middleware/logger.ts`

**The per-request access log.**

This file is the clearest demonstration of *why* middleware takes a `next` function. When it starts, the response does not exist yet — there is no status code to log. Only after `await next()` returns does the outcome exist.

```ts
const startedAt = process.hrtime.bigint();
try {
  await next();
} finally {
  const status = ctx.res.statusCode;
  // ... log
}
```

`finally` runs on both paths, so failures are logged too. And note that it does **not** catch — the error still propagates outward, because the logger's job is to observe, not to handle.

Two details:

- `process.hrtime.bigint()` is a *monotonic* clock. `Date.now()` can jump backwards mid-request (NTP correction, daylight saving) and produce a negative duration.
- Colour is enabled only when `process.stdout.isTTY` is true and `NO_COLOR` is unset. Colour codes in a log file are noise.

### 5.11 `src/middleware/errorHandler.ts`

**The single place where a thrown error becomes an HTTP response.** Because of this file, no other file in the project contains a `try`/`catch` whose purpose is producing an error response.

```ts
return async (ctx, next) => {
  try {
    await next();
  } catch (error: unknown) {
    const httpError = toHttpError(error, exposeInternalErrors);

    if (httpError.status >= 500 && logServerErrors) {
      console.error(`[error] ${ctx.method} ${ctx.url.pathname} failed:`, error);
    }

    if (ctx.res.headersSent) {
      ctx.res.destroy();
      return;
    }

    const extraHeaders: Record<string, string> =
      httpError instanceof MethodNotAllowedError
        ? { Allow: httpError.allowed.join(', ') }
        : {};

    sendError(ctx.res, httpError, extraHeaders);
  }
};
```

Four decisions worth understanding.

**It logs the *original* error, not the translated one.** By this point the 500 we are about to send has discarded everything useful, so logging `httpError` would record our own generic message and the real stack would be gone forever.

**Client errors are not logged here.** A 4xx is normal traffic, already captured in the access log. Only 5xx gets a stack trace.

**`exposeInternalErrors`** is set by `app.ts` to `config.nodeEnv !== 'production'`. In development the 500 message includes the underlying error's name and message, because "Internal Server Error" with no detail is maddening to debug. In production it does not, because internal error messages routinely contain file paths, database names and library internals. The two audiences need different information, and this is where that split happens.

**The `headersSent` branch** handles the case where a handler threw midway through writing a body. The status line and headers are already on the wire and cannot be taken back, so there is no correct status code left to send. `res.destroy()` is the honest signal: the client sees an incomplete response rather than a plausible-looking but truncated one.

`toHttpError` is the other half:

```ts
function toHttpError(error: unknown, exposeInternalErrors: boolean): HttpError {
  if (error instanceof HttpError) return error;
  if (!exposeInternalErrors) return new InternalServerError();
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new InternalServerError(`An unexpected internal error occurred (${detail}). ...`);
}
```

Anything that is not an `HttpError` is a bug or an unexpected failure, and from the client's point of view those are all the same thing.

> Compare with Express, where error middleware is a four-argument function `(err, req, res, next)` and must be registered last. The idea is identical; only the calling convention differs.

### 5.12 `src/middleware/cors.ts`

**Sets CORS headers and answers preflight requests.**

The thing to internalise, and it surprises almost everyone: **CORS is enforced by the browser, not the server.** These headers are instructions to the browser about what it may let JavaScript read. A `curl` command or a server-to-server call ignores them completely. If you need real access control, that is authentication, and it is a separate concern.

The middleware sets the simple-response header first, so it is present on *every* response including errors:

```ts
res.setHeader('Access-Control-Allow-Origin', options.origin);
if (options.origin !== '*') {
  res.setHeader('Vary', 'Origin');
}
```

A browser cannot read a response that lacks `Access-Control-Allow-Origin`. If you only set it on success, a 422 becomes an opaque network error in the console instead of a readable validation message.

`Vary: Origin` tells caches the response depends on the request's `Origin` header, so a cached response for one origin is never replayed to another. With `'*'` the response is identical for everyone, so `Vary` would be pointless.

Preflight short-circuits:

```ts
if (ctx.method === 'OPTIONS') {
  res.setHeader('Access-Control-Allow-Methods', options.methods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', options.headers.join(', '));
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Allow', options.methods.join(', '));
  sendNoContent(res);
  return;   // <-- note: no next()
}
```

Returning without calling `next()` is the **short-circuit** pattern. The request never reaches the router, which is why `OPTIONS` succeeds on a path that has no routes at all. That is intentional: the browser is asking about the API as a whole, not about a resource.

`Access-Control-Max-Age` lets the browser cache the preflight for a day. Without it, every single `PUT` costs two round trips instead of one.

### 5.13 `src/middleware/defaultHeaders.ts`

**Two headers on every response, declared in one place.**

```ts
ctx.res.setHeader('Cache-Control', 'no-store');
ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
await next();
```

`no-store` because this API returns mutable data addressed by URL: a cached `GET /api/tasks` could hand a user a stale list immediately after they created a task. Correct caching is possible but needs `ETag` and per-resource `max-age` worked out; until then, honesty beats a stale cache.

`nosniff` stops a browser from sniffing the content type and deciding a JSON response is really HTML or JavaScript. Without it, a crafted body could be executed as a script in some older browsers.

The value of a tiny middleware like this is not the two lines — it is that nothing downstream can *forget* them.

### 5.14 `src/validation/task.validation.ts`

**The trust boundary.** This is the most important file to understand, because it embodies the lesson that takes longest to learn:

> **TypeScript's types do not exist at runtime, so they cannot validate anything.**

A client can POST a number where a string belongs, a 5 MB nested array, or a field you have never heard of. From the type checker's point of view, that data is whatever your `interface` says it is. Its types are a *description of intent*, not a *guarantee about reality*.

So every function here takes `unknown` and either returns a trustworthy value or throws a 422. The shape is always the same:

1. Prove the input is a JSON object.
2. Walk each field, **collecting** problems rather than throwing at the first.
3. If anything was wrong, throw once with the complete list.
4. Otherwise return a freshly built, fully populated value.

`FieldCollector` is a small class rather than a plain array so each reader can call `collector.add(...)` and return, instead of every function threading an array around. Its `ok` getter is a *getter* rather than a method so callers write `collector.ok` — a getter lets a trivial computation masquerade as a property, which reads better.

`isOneOf` is where generics and type guards meet:

```ts
function isOneOf<T extends string>(candidates: readonly T[], value: string): value is T {
  return candidates.some((candidate) => candidate === value);
}
```

`T extends string` is a *generic constraint* — T may be any type assignable to `string`. Without it, `candidate === value` would be an error, because comparing two unrelated types is almost always a bug. The return type `value is T` is a *type predicate*: a promise that a `true` result means the caller may narrow `value` to `T`. The compiler cannot verify that promise, so a wrong predicate silently produces unsound code — the price of being able to teach the compiler about your own runtime checks.

`isTaskPriority` builds on it, and then `readPriority` needs no cast at all.

The readers return `undefined` for two different situations — "the field was absent" and "the field was invalid" — and the callers distinguish them. `parseTaskWriteInput` treats absence as "use the default"; `parseTaskUpdateInput` treats it as "leave it alone", which is why a PATCH can update one field without touching the others.

`parseTaskWriteInput`'s guard is doing double duty:

```ts
if (title === undefined || !collector.ok) {
  throw new UnprocessableEntityError('The request body failed validation.', collector.issues);
}
```

`!collector.ok` asks "did anything fail?". The `title === undefined` half is what lets TypeScript narrow `title` from `string | undefined` to `string` for the `return` below. Reading the type checker's mind like this is normal in TypeScript; the alternative is `title!`, which throws away the checking instead of using it.

`parseTaskUpdateInput` needs a mutable local type, and that deserves a note:

```ts
interface MutableTaskUpdate {
  title?: string;
  description?: string | null;
  priority?: TaskPriority;
  completed?: boolean;
}
```

`TaskUpdateInput` marks every property `readonly`, which is right for values being passed *into* a store. But here we are assembling the object one field at a time, and TypeScript will not let you assign to a readonly property — even one on an object you just created. A local mutable type solves that cleanly, and converting between the two is free because their shapes are identical. Use a mutable type while building; hand back the readonly view.

Finally, `parseTaskListQuery` throws a **400**, not a 422. Query parameters are part of the URL, so a `limit` that is not a number makes the request itself malformed rather than the body semantically unacceptable. See [chapter 06](06-errors-and-status-codes.md) for where to draw that line.

### 5.15 `src/data/task.store.ts`

**The only file that knows how tasks are kept.**

This is the repository pattern, and its value is not ceremony — it is that the HTTP layer never learns whether the data lives in memory, in Postgres, or behind a call to another service.

The whole store is a `Map`:

```ts
readonly #tasks = new Map<string, Task>();
```

`Map` beats a plain object here. Ids are UUIDs and always safe as keys, but a `Map` sidesteps the prototype-key question (`obj['constructor']` is a real footgun), has a real `.size`, and preserves insertion order — which is the order `list()` returns, and is predictable and stable.

The methods are worth reading for the decisions they encode:

- **`list`** filters, then paginates with `slice`, and returns `{ items, total }` where `total` counts matches *before* pagination. That is what lets a client render "showing 20 of 137". An absent filter means "no opinion", which is why the comparison is `query.completed === undefined` rather than a falsy check.
- **`create`** is the only place a task is ever constructed, which is why seeding goes through it too.
- **`replace`** carries `id` and `createdAt` over from the existing task. Those identify the resource rather than describe its contents, so a replace must not disturb them.
- **`update`** has one subtle line:

  ```ts
  description: patch.description === undefined ? existing.description : patch.description,
  ```

  `??` would be wrong here. A patch of `{"description": null}` is a deliberate request to *clear* the description, and `null ?? existing.description` would treat that `null` as "nothing to do" and keep the old text. Only `undefined` — meaning the field was absent — should preserve the existing value.

- **`delete`** returns a boolean and lets `Map.delete` do the work. A separate existence check would be redundant *and* would be a race in a concurrent setting.
- **`clear`** is not exposed over HTTP. It exists for tests, and it is a reminder that "the store is the only thing that touches the data" cuts both ways.

The store deliberately does **not** throw `NotFoundError`. It returns `undefined`. The handler knows the request context; the store does not, and should not.

### 5.16 `src/data/seed.ts`

**Four sample tasks.**

They are `TaskWriteInput` values, not `Task` values, and the difference is the point: an input has no `id`, `createdAt` or `updatedAt`, because those belong to the server. Seeding through the same type `POST` uses means there is exactly one code path that can create a task.

### 5.17 `src/routes/health.routes.ts`

**`GET /health`,** and a short argument for why every deployable API needs one.

Monitoring tools, container orchestrators (Kubernetes readiness and liveness probes) and load balancers all need a cheap way to ask "are you alive?". Without a dedicated endpoint they probe a real resource, which is wasteful and gives misleading answers when that resource is legitimately empty.

Note what is *not* there: no authentication, no database query, nothing fallible. A health check that depends on something that can fail will report your service as down for reasons that have nothing to do with it. A deeper "is everything working?" check belongs on a separate endpoint, usually `/health/ready`.

It is also not under `/api`, because it is infrastructure rather than part of the API proper — a convention, not a rule, but a widely followed one.

### 5.18 `src/routes/tasks.routes.ts`

**The six task endpoints.** Everything HTTP-specific lives here; the store never sees a status code.

The module takes its dependencies as an argument rather than importing globals:

```ts
export interface TaskRouteDependencies {
  readonly store: TaskStore;
  readonly maxBodyBytes: number;
}

export function registerTaskRoutes(router: Router, deps: TaskRouteDependencies): void {
```

That is dependency injection, and the practical payoff is testability: a test can build an app with its own store and its own limits and run in complete isolation. It also makes the dependencies *visible* — reading the signature tells you everything this module needs.

Four decisions in here are worth internalising, because they are exactly the kind of thing beginners get wrong.

**`POST` returns `201` and a `Location` header, never `200`.** A new resource now exists at a URL that did not exist before. The body is the created task *including* the server-generated id, timestamps and defaults — which saves a follow-up `GET` and removes any ambiguity about what was actually stored.

**`PUT` replaces, `PATCH` updates.** `PUT` uses the same validated input type as `POST`, because both mean "here is the complete state". Omitted optional fields reset to their defaults. `PATCH` accepts any subset and preserves what it does not mention. That preservation is what makes `PATCH` the right choice for toggling a checkbox: send `{"completed": true}` and the title is safe even if another client changed it a moment ago. It avoids the *lost update* problem that a read-modify-write `PUT` cycle is vulnerable to.

**`PUT` does not create.** A strict reading of HTTP says `PUT` may create a resource at a client-chosen URL. We deliberately do not, because ids are server-generated UUIDs and a client cannot know one in advance. So a `PUT` to an unknown id is a 404. This is a documented deviation from the letter of the spec, and a very common one.

**`DELETE` returns `204` with no body, but a second delete returns `404`.** There is no resource left, so a 200 with `{}` would only give the client something to ignore. Reporting 404 rather than a second 204 makes deleting an id you got from a typo fail loudly instead of succeeding silently.

The `GET /api/tasks` handler is the one that sets a custom header:

```ts
ctx.res.setHeader('X-Total-Count', String(total));
sendJson(ctx.res, 200, items);
```

The body is a bare JSON array — identical in shape to any other JSON source — and the metadata goes in a header where HTTP already has a place for it. An envelope like `{ "data": [...], "total": 137 }` is the common alternative; it is easier for clients that cannot read headers, but less conventional. The choice matters less than making it once and documenting it.

### 5.19 `src/server.ts`

**The entry point.** One job: start a server, and stop it cleanly.

`createServer(app.listener)` wraps the listener without binding anything. `server.listen(...)` binds. `server.on('error', ...)` handles `EADDRINUSE` and friends, which arrive as events rather than exceptions because binding is asynchronous. And `process.exitCode = 1` is used rather than an immediate `process.exit()`, so pending output flushes and the error message is not occasionally swallowed.

The most interesting part is `shutdown`:

```ts
server.close((error) => { /* ... */ });
server.closeIdleConnections();

const forceExit = setTimeout(() => {
  server.closeAllConnections();
}, SHUTDOWN_GRACE_MS);

forceExit.unref();
```

Three Node APIs, and each one is there for a reason:

- **`server.close(cb)`** stops accepting new connections and calls `cb` once every existing connection has closed. Crucially, it does **not** close idle keep-alive connections — it *waits* for them, and a browser that has finished with you but not hung up will hold them open. This is why `server.close()` on its own can appear to hang.
- **`server.closeIdleConnections()`** closes the connections that are merely sitting between requests. This is what actually lets `close` finish promptly.
- **`server.closeAllConnections()`** force-closes everything, including requests still in flight. That is the big hammer, used only after the grace period expires.

`forceExit.unref()` tells the event loop not to keep the process alive just for that timer. Without it, a *clean* shutdown would always take the full ten seconds before the process could exit.

Without all of this, `npm run dev` on Windows leaves the port held for a few seconds after Ctrl+C, and your next start fails with `EADDRINUSE`.

A second signal exits immediately — a second Ctrl+C means "I meant it" — and `SIGTERM` is registered alongside `SIGINT` because that is the signal Docker, systemd and most process managers send.

### 5.20 `src/app.ts`

**Wires everything together, and listens on nothing.**

That last part is deliberate and load-bearing. The tests import this file, build an app, and listen on a random free port themselves. If this module started a server on import, every test file would fight over port 3000 and the suite could not run in parallel.

The middleware array is the file's real content:

```ts
const middlewares: readonly Middleware[] = [
  createLogger({ enabled: options.logRequests ?? config.logRequests }),
  createErrorHandler({ exposeInternalErrors: config.nodeEnv !== 'production' }),
  createDefaultHeaders(),
  createCors({ origin: ..., methods: ALLOWED_METHODS, headers: ALLOWED_HEADERS }),
  (ctx) => router.dispatch(ctx),
];
```

To read this correctly, remember that each middleware can rely on everything *inside* it and must cope with everything *outside* it. The logger is outside the error handler, so it can trust that by the time it regains control the response is finished. The error handler is outside the router, so it can trust that anything the router or a handler throws will reach it.

The router is just the last middleware. A function that ignores its second parameter is a valid `Middleware`, so `(ctx) => router.dispatch(ctx)` needs no wrapper.

`ALLOWED_HEADERS` contains `Content-Type` and `Accept`:

```ts
const ALLOWED_HEADERS = ['Content-Type', 'Accept'];
```

`Content-Type` must be listed or the browser blocks every JSON write during preflight. Note that `X-Total-Count` does **not** belong here — that is a *response* header, and letting browser JavaScript read a custom response header requires `Access-Control-Expose-Headers` instead. Exactly the kind of detail that makes CORS worth reading about properly before relying on it.

Finally the listener, whose `.catch()` is the last-resort handler described in §2 step 3d.

### 5.21 `tests/`

**Two test files and one helper.** Covered in full in [chapter 07](07-testing-the-api.md); the short version:

- `unit.test.ts` — `TaskStore` and the validators, tested directly. These are the only two modules with real logic; everything else is plumbing. Testing them directly means a failure points at the exact function that broke.
- `api.test.ts` — end-to-end over a real socket with real `fetch`. Nothing is mocked, so it verifies the contract a client actually experiences: status codes, headers, JSON shape.
- `helpers/testServer.ts` — builds an app, creates a server, listens on **port 0** so the OS picks a free port, and reads the real port back from `server.address()`. Its `close()` calls `closeAllConnections()` before `close()`, because `fetch` keeps sockets alive in a pool and `server.close()` would otherwise wait forever. That is a real trap, and it is why the helper exists.

`beforeEach(() => server.app.store.clear())` gives every test an empty store. Tests that pass or fail depending on execution order are the single most annoying kind of suite to debug.

---

## 6. The layering rules

The dependency direction from [§1](#1-the-shape-of-the-codebase) is the one rule that keeps this codebase comprehensible. Stated as permissions:

| Layer | May import from | Must not import from |
|---|---|---|
| `types/` | nothing | everything else |
| `http/` | `types/`, Node built-ins | `data/`, `routes/`, `middleware/` |
| `validation/` | `types/`, `http/errors.ts` | `data/`, `routes/` |
| `data/` | `types/` | `http/`, `routes/`, `validation/` |
| `router.ts` | `types/`, `http/errors.ts` | `routes/` |
| `middleware/` | `types/`, `http/` | `routes/`, `data/` |
| `routes/` | everything above | `middleware/` |
| `app.ts` | everything | — |

Two rules do most of the work:

**`data/` must not import `http/`.** The moment the store knows about status codes, it is no longer swappable for a database. This is why `findById` returns `Task | undefined` instead of throwing `NotFoundError` — the *handler* knows the request context and decides the status code.

**`http/` must not import `data/`.** `readJsonBody` and `sendJson` have nothing to do with tasks. Keep them that way and you can reuse them for the next resource without editing them.

You can check the first rule mechanically: if you ever need to `import { NotFoundError }` inside `src/data/`, stop and move the throw up into the route handler.

---

## 7. Recipes: where to change what

| You want to... | Change | Read first |
|---|---|---|
| Add a new endpoint on an existing resource | `src/routes/tasks.routes.ts` | [05](05-routing-and-middleware.md) |
| Add a whole new resource | New file in `src/routes/`, a new store in `src/data/`, a new type in `src/types/`, register in `app.ts` | This chapter |
| Change validation rules | `src/validation/task.validation.ts` | [06](06-errors-and-status-codes.md) |
| Add a new field to a task | `src/types/task.ts`, then the validator, then `create`/`replace`/`update` in the store | — |
| Add a new error type | `src/http/errors.ts`; it is handled automatically by the error handler | [06](06-errors-and-status-codes.md) |
| Add a response header to everything | `src/middleware/defaultHeaders.ts` | [05](05-routing-and-middleware.md) |
| Add a new middleware | Write it in `src/middleware/`, add it to the array in `app.ts` — **and think about where** | [05](05-routing-and-middleware.md) |
| Change the log format | `src/middleware/logger.ts` | — |
| Change CORS or the allowed headers | `src/middleware/cors.ts` and `ALLOWED_HEADERS` in `app.ts` | — |
| Add configuration | `src/config.ts` and `.env.example` | [03](03-node-runtime-and-the-http-module.md) |
| Make data persist | Replace `src/data/task.store.ts` with a SQLite-backed store exposing the same methods | [08](08-next-steps.md) |
| Add authentication | New middleware in `src/middleware/`, placed **after** CORS and **before** the router | [08](08-next-steps.md) |
| Add a test | `tests/api.test.ts` for behaviour, `tests/unit.test.ts` for logic | [07](07-testing-the-api.md) |

---

**Next:** [05 — Routing and middleware](05-routing-and-middleware.md) takes the two pieces this chapter only sketched — `router.ts` and `compose.ts` — and works through them properly.
