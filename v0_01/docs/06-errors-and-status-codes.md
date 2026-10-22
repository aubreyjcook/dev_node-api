# Errors and Status Codes

A successful API is easy to describe and boring to read about. The interesting part is what happens when things go wrong, because that is where clients break, where bugs hide, and where careless design leaks information.

This document covers how this API reports failure: the JSON envelope every error uses, the `HttpError` hierarchy in [`src/http/errors.ts`](../src/http/errors.ts), the single middleware in [`src/middleware/errorHandler.ts`](../src/middleware/errorHandler.ts) that turns a thrown value into a response, and the reasoning behind every status code the project sends.

Two properties shape everything below. The project has **zero runtime dependencies**, so error handling is not a framework feature you configure — it is about 110 lines of TypeScript you can read in one sitting. And **Node 24 runs the `.ts` files directly**, stripping types, which means the class hierarchy is *real JavaScript at runtime*: `instanceof` works, prototypes work, and there is no transpilation step where those things can go wrong. See [TypeScript for JavaScript Developers](./02-typescript-for-javascript-developers.md) for why the code is written the way it is.

## 1. Why a uniform error shape matters

Every failure this API can produce — except one rare case covered in section 8 — leaves the server as the same JSON envelope, built by a single function ([`sendError`](../src/http/response.ts) in `src/http/response.ts`):

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request body failed validation.",
    "details": [
      { "field": "title", "message": "Must not be empty or whitespace only." }
    ]
  }
}
```

A client that can parse that shape once can parse every failure the API will ever send. There is no second format for the router's 404s, no HTML error page, no bare text. Error handling on the client is written once, tested once, and never needs a special case for "the error from this endpoint looks different."

### `code` versus `message`

| Field | Audience | Stability | Purpose |
| --- | --- | --- | --- |
| `code` | Code | A stable contract. `SCREAMING_SNAKE_CASE`, never localized, changed only as a deliberate breaking change | Branch on this: `VALIDATION_FAILED`, `NOT_FOUND`, `PAYLOAD_TOO_LARGE` |
| `message` | Humans | Unstable. May be reworded, improved or expanded in any release without notice | Log it, show it to a developer, paste it into a bug report. Never `if` on it |
| `details` | Code and humans | Present only when there is something to say | Structured, usually per-field information |

The rule is blunt: **clients branch on `code`, never on `message`.** A client that writes `if (error.message === 'No task exists with id "42".')` has hard-coded an id, a quote style and a sentence somebody will reword next week. A client that checks `error.code === 'NOT_FOUND'` survives every wording change.

`details` is **omitted entirely** when there are none, rather than sent as `null` or `[]`. Both alternatives would force every client to distinguish "no details" from "an empty list of details", a distinction that does not exist. `sendError` adds the property conditionally, so a 404 envelope is literally two fields.

### Writing the client side once

`details` exists so a form can attach each message to the right input. `field` is the JSON property name of the offending value (or the query parameter name, or the literal string `(body)` when the problem is the body as a whole), so the client side is a loop that knows nothing about any particular endpoint:

```ts
if (!response.ok) {
  const { error } = await response.json();

  // Branch on the stable machine-readable code.
  if (error.code === 'VALIDATION_FAILED') {
    // `details` is absent when there is nothing per-field to report.
    for (const issue of error.details ?? []) {
      showFieldError(issue.field, issue.message);
    }
  } else {
    showBanner(error.code, error.message);
  }
}
```

Note what it does *not* do: parse `message`, guess the offending field from prose, or carry special cases for individual endpoints.

## 2. The `HttpError` hierarchy

All seven error types live in one file, [`src/http/errors.ts`](../src/http/errors.ts). That file is the complete error vocabulary of the API — there is nothing else to learn.

| Class | Status | `code` | Thrown when |
| --- | --- | --- | --- |
| `BadRequestError` | 400 | `BAD_REQUEST` | Body is empty; body is not valid JSON; a query parameter is invalid (`?limit=abc`); a path segment has a malformed percent-escape (`/api/tasks/%zz`) |
| `NotFoundError` | 404 | `NOT_FOUND` | No route matches the path, **or** the task id does not exist (GET/PUT/PATCH/DELETE) |
| `MethodNotAllowedError` | 405 | `METHOD_NOT_ALLOWED` | The path matches some route but not this method. Carries `allowed: readonly string[]`, which the error handler turns into the `Allow` response header |
| `PayloadTooLargeError` | 413 | `PAYLOAD_TOO_LARGE` | Body exceeds `MAX_BODY_BYTES` (default 100000), checked from `Content-Length` first and again while streaming |
| `UnsupportedMediaTypeError` | 415 | `UNSUPPORTED_MEDIA_TYPE` | A body was sent but `Content-Type` is missing or is not a JSON media type |
| `UnprocessableEntityError` | 422 | `VALIDATION_FAILED` | Valid JSON that fails semantic validation. Carries a list of `{ field, message }` issues |
| `InternalServerError` | 500 | `INTERNAL_ERROR` | Any error that is not an `HttpError`. Message is deliberately generic |

Every one is a thin subclass of `HttpError`, which is a thin subclass of `Error`:

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

export class BadRequestError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}
```

Only three fields are added, and they are exactly the three the error handler needs: a status to send, a code for the envelope, and optional structured details.

### Why a base class instead of bare `Error` or a sentinel return

| Design | Problem |
| --- | --- |
| `throw new Error('not found')` | The HTTP meaning exists only as prose. The handler would have to match on message text — the thing section 1 forbids — or guess. A deliberate 404 and an accidental `TypeError` become indistinguishable, and both turn into a 500 |
| Return a sentinel (`undefined`, `false`, `-1`) | The caller can ignore it. TypeScript will not force the check unless every function returns a `Result` union, and "why" — which field was invalid, which methods are allowed — has nowhere to live |
| One `HttpError` base with `status` and `code` | A single `instanceof HttpError` separates "deliberate outcome" from "bug", and every deliberate outcome already carries what a response needs |

### Why subclasses instead of `new HttpError(400, 'BAD_REQUEST', ...)` everywhere

Calling the base constructor at every throw site would technically work, but it scatters the mapping decision — "this situation means 400 with code `BAD_REQUEST`" — across the codebase instead of stating it once beside the definition. Subclasses give four concrete things:

1. **Intent at the throw site.** `throw new NotFoundError(...)` reads as a sentence; `throw new HttpError(404, 'NOT_FOUND', ...)` reads as a number.
2. **The pair cannot drift.** It is impossible to throw a 400 carrying the code `VALIDATION_FAILED`, or to renumber a status in one place and forget the other eighteen.
3. **Extra fields are possible.** `MethodNotAllowedError` carries `allowed`, which is what makes the `Allow` header possible. A generic base call has no natural place for it.
4. **Renumbering is a one-line change.** If a missing task on `DELETE` later became a 204, that is one constructor argument in `errors.ts`, not a search across every handler.

### `this.name = new.target.name`

`name` is inherited from `Error.prototype`, where it is the string `'Error'`, and nothing sets it for a subclass. Without the assignment, all seven classes would log as:

```text
Error: No task exists with id "nonexistent-id".
```

With it, the first line of the stack identifies the class, which is what makes filtering for `NotFoundError` or alerting on an unexpected `TypeError` possible at all:

```text
NotFoundError: No task exists with id "nonexistent-id".
```

`new.target` is plain JavaScript: it refers to the constructor actually invoked with `new`. When `new NotFoundError(...)` calls `super(message)`, the base constructor still sees `new.target === NotFoundError`, and this keeps working for a subclass of a subclass. A hard-coded `this.name = 'NotFoundError'` in each class would also work, but every new class would sit one forgotten line away from logging as `Error` again.

The constructor assigns fields rather than using TypeScript's parameter-property shorthand (`constructor(readonly status: number)`), because parameter properties *generate* assignment code and the project's `erasableSyntaxOnly` setting rejects that. Node must be able to strip the types without adding anything back.

### Why `HttpError extends Error` needs no `Object.setPrototypeOf` fix

Extending a built-in used to require a workaround in every subclass constructor — `Object.setPrototypeOf(this, new.target.prototype)`, written by hand in each one. The cause was transpilation. Downleveled to ES5, a class became a plain function, and `Error` returns its own new object, so `this` inside the subclass did not have the right prototype: `instanceof` failed and methods went missing. The workaround patched the prototype back on by hand.

Nothing here downlevels. [`tsconfig.json`](../tsconfig.json) targets `es2024`, and Node 24 executes the `.ts` files directly, stripping types without transforming syntax. So `class BadRequestError extends HttpError` is a genuine native subclass: `new NotFoundError(...) instanceof HttpError` is `true`, `message` is set and `stack` is intact. The workaround belongs to build pipelines that target below ES2015; adding it here would be harmless but misleading.

## 3. The big win: throwing from anywhere

The hierarchy pays for itself because **no code in the request path has to construct an HTTP response**. A deliberate failure is expressed by throwing, and the throw unwinds however many stack frames it takes to reach the one place that knows how to respond.

Here is the real code for reading a single task, from [`src/routes/tasks.routes.ts`](../src/routes/tasks.routes.ts):

```ts
router.get('/api/tasks/:id', (ctx) => {
  const task = store.findById(requireParam(ctx, 'id'));

  if (task === undefined) {
    throw new NotFoundError(`No task exists with id "${requireParam(ctx, 'id')}".`);
  }

  sendJson(ctx.res, 200, task);
});
```

And here is the validator, from [`src/validation/task.validation.ts`](../src/validation/task.validation.ts):

```ts
export function parseTaskWriteInput(body: unknown): TaskWriteInput {
  const raw = requireJsonObject(body);
  const collector = new FieldCollector();

  rejectUnknownFields(raw, collector);
  const title = readTitle(raw, collector, true);
  // ...description, priority, completed...

  if (title === undefined || !collector.ok) {
    throw new UnprocessableEntityError('The request body failed validation.', collector.issues);
  }

  return { title, description: description ?? null, priority: priority ?? DEFAULT_PRIORITY, completed: completed ?? false };
}
```

Neither function touches `res`. Neither picks a status line, sets a header, or serializes JSON. The status `422` and the code `VALIDATION_FAILED` were decided once, in `UnprocessableEntityError`'s constructor. A store or validator can throw `NotFoundError` in exactly the same way; nothing about the error requires knowledge of HTTP.

### The store goes one step further

`TaskStore.findById` does not even throw: it returns `undefined`, and the route handler — the layer that knows a URL was requested — decides that means 404. The store's own comment gives the reason, and `replace`, `update` and `delete` follow the same rule (`delete` returns a boolean for exactly this purpose). You could equally have the store throw `NotFoundError` and get the same 404, because the error handler would catch it identically. This project draws the line one notch stricter, so the *name* of an HTTP status never appears in `src/data/`. Both designs share the central benefit: **the throw site never builds a response.**

### The alternative, and why it is worse

Without exceptions, every function that can fail must return the failure and every caller must carry it upward:

```ts
// The design this project deliberately avoids.
function findTask(id: string): { status: number; body: unknown } {
  const task = store.findById(id);
  if (task === undefined) {
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: `No task exists with id "${id}".` } } };
  }
  return { status: 200, body: task };
}

router.get('/api/tasks/:id', (ctx) => {
  const result = findTask(requireParam(ctx, 'id'));
  if (result.status !== 200) {
    return result; // the failure has to be carried by hand
  }
  sendJson(ctx.res, 200, result.body);
});
```

Three things get worse, and all three compound:

1. **The failure can be forgotten.** Nothing forces the caller to inspect `status`; a handler that ignores it sends a 200 containing an error body. With a thrown error, forgetting is impossible — the request does not continue.
2. **Every layer needs the same signature.** A helper in the data layer must return a shape that only makes sense to the HTTP layer — exactly the coupling `TaskStore`'s `undefined` return avoids.
3. **Errors become values, so they mix with real values.** The caller cannot tell "here is a task" from "here is a failure" without convention and discipline.

The cost of exceptions is small but real: control flow that ends a request is invisible at the call site. The mitigation is that the whole vocabulary lives in one file, and every function that throws says so in its JSDoc.

## 4. Error handling as middleware, and why position matters

`createErrorHandler` is the one place a thrown value becomes a response. Its core is four lines:

```ts
return async (ctx, next) => {
  try {
    await next();
  } catch (error: unknown) {
    const httpError = toHttpError(error, exposeInternalErrors);
    // ...log, then either destroy the socket or send the envelope...
  }
};
```

Because [`compose`](../src/middleware/compose.ts) implements the onion model — each middleware receives a `next` that runs the entire remainder of the pipeline — that `try` wraps *everything downstream of it*: body parsing, validation, the store, the router, the handler. One `try`/`catch` covers the application.

```text
  logger        ──┐
    errorHandler ──┼──┐
      cors       ──┼──┼──┐
        router   ──┼──┼──┼──▶ (handler writes the response)
        router   ◀──┼──┼──┘
      cors       ◀──┼──┘
    errorHandler ◀──┘   (catches anything thrown on the way down)
  logger         ◀─────┘   (logs the final status code)
```

The order is set in [`src/app.ts`](../src/app.ts):

| Position | Middleware | What it can rely on |
| --- | --- | --- |
| 1 (outermost) | `createLogger` | By the time it regains control, the response is finished and `res.statusCode` is final |
| 2 | `createErrorHandler` | Anything thrown by layers 3–5, or by the handler, reaches it |
| 3 | `createDefaultHeaders` | `Cache-Control` and `nosniff` are on every response, including errors |
| 4 | `createCors` | CORS headers are set before `await next()`, so they appear on error responses too; `OPTIONS` is answered here and never reaches the router |
| 5 (innermost) | the router | It either responds or throws |

### Why the logger must be outside the error handler

This single ordering decision is easy to get wrong and produces actively misleading logs.

`res.statusCode` starts at **200** — Node's default, not a statement about the outcome. A middleware that reads it before the response is written reads 200. The logger's `finally` block does exactly that:

```ts
} finally {
  const status = ctx.res.statusCode;
  // ...console.log(`... ${ctx.method} ${target} ${status} ...`)
}
```

With the order `[errorHandler, logger, ...]`, the logger sits *inside* the catch, so its `finally` runs while the error handler has not yet responded and `res.statusCode` still holds the untouched default. The access log would claim:

```text
14:03:22.481 POST   /api/tasks 200 0.4ms
```

while the client received a 422. Every dashboard, every error-rate metric and every `grep ' 500 '` would be wrong, and the bug would look like a monitoring problem rather than an ordering problem. With the logger outside, the error handler has already called `writeHead(422, ...)` by the time the logger wakes up, so the log line agrees with the wire. That is the concrete version of the rule stated in `app.ts`: each middleware can rely on everything inside it, and must cope with everything outside it. Middleware order is not decoration; it is program structure.

### Why the error handler must be outside the router and CORS

- **Outside the router**, so that everything routing or a handler throws is inside its `try`: matching, percent-decoding, body parsing and validation all throw `HttpError`s that need to become responses.
- **Outside CORS**, so a failure in the CORS layer itself is contained. `defaultHeaders` and `createCors` set their headers *before* `await next()`, so those headers are already attached to `res` when the error handler calls `writeHead`, and `writeHead` merges with rather than replaces them. A 422 or a 500 therefore still carries `Access-Control-Allow-Origin`, `Cache-Control` and `X-Content-Type-Options`, and a browser client can actually read the error instead of reporting an opaque network failure.
- **Inside the logger**, for the reason above and no other. Nothing wraps the error handler except logging.

### Compared with Express

Express does the same job with a genuinely different mechanism: error middleware is identified by its *arity*.

```ts
// Express: four parameters, registered after every other route and middleware.
app.use((err, req, res, next) => {
  res.status(err.status ?? 500).json({ error: { code: err.code ?? 'INTERNAL_ERROR', message: err.message } });
});
```

| | Express | This project |
| --- | --- | --- |
| How error middleware is found | `fn.length === 4`, a reflection trick | It is item 2 in the middleware array, and its position is visible |
| How an error arrives | A handler must call `next(err)`, or a wrapper must catch a rejected promise | Any `throw` or rejection propagates up the `await` chain automatically |
| Async handlers | A rejected promise in an `async` handler is *not* routed to error middleware without `next(err)` or a wrapper | `await next()` is inside the `try`, so a synchronous throw and a rejection are indistinguishable |
| Registration order | Must be last, and a route added afterwards silently escapes it | It is an array literal in `src/app.ts`; reordering is a visible edit |

Express's design is fine, just a different set of conventions. The point of the comparison is that "one middleware catches everything" is a universal idea, and this project implements it with syntax the language already has rather than with a calling convention you have to remember. A last-resort `.catch` on the pipeline promise in `app.ts` prints `[fatal] An error escaped the middleware pipeline:` and sends a hand-written 500, because Node does not await the promise and an unhandled rejection would terminate the process. It should be unreachable; it exists so one malformed request can never take down the server.

## 5. The status code decision table

Success codes first, so the failures have a baseline to contrast with:

| Method | Path | Success | Where the code is chosen |
| --- | --- | --- | --- |
| GET | `/health` | 200 | `registerHealthRoutes` |
| GET | `/api/tasks` | 200 | `registerTaskRoutes` |
| POST | `/api/tasks` | 201 | `registerTaskRoutes`, plus a `Location` header |
| GET | `/api/tasks/:id` | 200 | `registerTaskRoutes` |
| PUT | `/api/tasks/:id` | 200 | `registerTaskRoutes` |
| PATCH | `/api/tasks/:id` | 200 | `registerTaskRoutes` |
| DELETE | `/api/tasks/:id` | 204 | `registerTaskRoutes`, via `sendNoContent` |

### 5.1 What went wrong, which status, and why

| What went wrong | Status | Why this status |
| --- | --- | --- |
| No route matches the path (`GET /api/nothing-here`) | 404 | The URL identifies nothing. Whether it was never implemented or the resource is gone is deliberately not distinguished |
| Route matches, id does not exist | 404 | The URL matched a pattern, but no resource is there — the same status as above, on purpose |
| Path matches, method does not (`PATCH /api/tasks`) | 405 | The URL exists; this verb is not part of its interface. RFC 9110 requires the `Allow` header |
| Body is not valid JSON (`{"title":`) | 400 | The request could not be parsed, so its contents were never evaluated |
| Body is empty on an endpoint that requires one | 400 | There was nothing to parse. Not a 415: the media type was never the problem |
| `?limit=abc`, `?completed=maybe`, unknown query parameter | 400 | The query string is part of the URL; a malformed one makes the request itself malformed |
| Malformed percent-escape in a path segment (`/api/tasks/%zz`) | 400 | The URL cannot be decoded into a value, so the request cannot be understood |
| Body sent as `Content-Type: text/plain` | 415 | The request is well framed; this API only reads JSON, and it says so instead of attempting a parse |
| Body larger than `MAX_BODY_BYTES` | 413 | The server refuses to buffer it. Checked from `Content-Length` and again while streaming |
| Valid JSON that fails the rules (empty title, unknown field, wrong type, non-boolean `completed`) | 422 | The request was fully understood; the data inside it is unacceptable |
| `PATCH` with nothing to update (`{}`) | 422 | Valid JSON, valid field names, but the instruction is empty — almost always a client bug |
| No task for that id on PUT/PATCH/DELETE | 404 | `replace`, `update` and `delete` report absence; the handler turns that into 404 |
| A route parameter is missing at runtime | 500 | Our bug — a handler registered on a pattern without that parameter — not the client's |
| Anything else thrown (`TypeError`, a rejected promise, a bare string) | 500 | Not an `HttpError`, so it is a bug or a failed dependency. The client message is deliberately generic |
| An error thrown after the response has started | no status | The status line is already on the wire. The socket is destroyed instead (section 8) |

Seven statuses and seven codes cover every failure this API can produce. That is small enough to hold in your head, which is a feature.

### 5.2 400 versus 415 versus 422

These are the three that beginners collapse into "400 for everything", and the collapse is worth avoiding because a client can act differently on each.

| Status | The question it answers | Attitude | Examples in this API |
| --- | --- | --- | --- |
| 400 Bad Request | "Could I even parse this request?" | *I could not get as far as understanding what you sent.* | Broken JSON, empty body, `?limit=abc`, `%zz` in the path |
| 415 Unsupported Media Type | "Do I read this format?" | *I understood the shape, and I refuse to read this media type.* | `Content-Type: text/plain`, or no `Content-Type` at all on a request with a body |
| 422 Unprocessable Content | "Is the data inside acceptable?" | *I understood it perfectly, and it is not acceptable.* | Empty `title`, unknown field `titel`, `priority: "urgent"`, `completed: "true"` |

The boundaries, stated once and held:

- **400 is about the transport-level shape of the request.** Bytes that are not JSON, a body that is not there, a query string that does not typecheck, a percent-escape that cannot be decoded. In every one of these cases the server never evaluated the *meaning* of anything.
- **415 is about the media type.** The framing is fine and the bytes arrived; the server declines to interpret them. Two requests with identical bytes produce different answers depending only on the `Content-Type` header, and that is correct: parsing a `text/plain` body as JSON would be guesswork.
- **422 is about the content.** Valid JSON, an accepted media type, and then the rules of the domain fail. This is the status that carries useful `details`, because by this point the server knows exactly which field was wrong and can say so.

**Be honest: this is a convention, not a law.** Plenty of widely used APIs send 400 for all three, and clients cope. What actually matters is *drawing the line once and holding it*. An API that sends 422 for an empty body on Monday and 400 on Tuesday is worse than one that always sends 400, because the client's error handling stops being reliable. This project's line is documented on `parseTaskListQuery` and in [HTTP and REST Fundamentals](./01-http-and-rest-fundamentals.md), and it is held everywhere.

One ordering detail is deliberate, in `readJsonBody`: the size checks come first (413), then the empty-body check (400), then the media type (415), then `JSON.parse` (400). The empty-body check therefore runs *before* the media-type check, which is why `curl -X POST` with no body and no `Content-Type` gets the message about an empty body rather than a lecture about media types. The most specific useful answer wins.

### 5.3 404 for two different things

`NotFoundError` is thrown from two unrelated places, and both produce 404:

```http
GET /api/nothing-here
HTTP/1.1 404 Not Found
{"error":{"code":"NOT_FOUND","message":"No resource exists at GET /api/nothing-here."}}
```

```http
GET /api/tasks/nonexistent-id
HTTP/1.1 404 Not Found
{"error":{"code":"NOT_FOUND","message":"No task exists with id \"nonexistent-id\"."}}
```

The first comes from `Router.dispatch` in [`src/router.ts`](../src/router.ts), after every registered route's path segments have been compared and none matched. The second comes from the handler in `src/routes/tasks.routes.ts`, after `TaskStore.findById` returned `undefined`. Different code paths, different messages, deliberately the same status:

- **It avoids telling a stranger which URLs exist.** If a missing route were one status and a missing resource another, an attacker could enumerate the API's surface by probing: "this URL is implemented but empty, that one is not implemented at all". With one status, `/api/nonsense` and `/api/tasks/nonexistent-id` are indistinguishable from outside. This is the same reasoning that makes a private resource answer 404 rather than 403 to a user who should not know it exists.
- **The client's reaction is identical.** "There is nothing at this URL" is one fact, and a generic client does not need to know which layer concluded it.
- **The messages still differ**, which is what humans need when debugging. Clients must not read them, so nothing is lost.

### 5.4 200 versus 201 versus 204

All three mean "it worked", and each says something different about the body.

**200 OK** — success, with a representation in the body. Used by `GET /health`, `GET /api/tasks`, `GET /api/tasks/:id`, and by `PUT` and `PATCH`, which return the updated task so the client learns the new `updatedAt` without a follow-up request.

**201 Created** — a new resource now exists at a URL that did not exist before. A `POST /api/tasks` with the body `{"title":"Buy milk"}` returns it with a `Location` header naming the new URL:

```http
HTTP/1.1 201 Created
Location: /api/tasks/3f2504e0-4f89-11d3-9a0c-0305e82c3301
Content-Type: application/json; charset=utf-8

{"id":"3f2504e0-4f89-11d3-9a0c-0305e82c3301","title":"Buy milk","description":null,"priority":"medium","completed":false,"createdAt":"2024-05-01T12:34:56.789Z","updatedAt":"2024-05-01T12:34:56.789Z"}
```

`Location` lets a well-behaved client follow up without constructing the URL itself, which means the URL scheme can change without breaking clients that read the header. Note that this project deviates from the letter of the spec by never creating on `PUT`: ids are server-generated UUIDs, so a client cannot choose one in advance, and a `PUT` to an unknown id is a 404.

**204 No Content** — the request succeeded and there is deliberately nothing to say. A successful `DELETE` (`sendNoContent` in `src/http/response.ts`):

```http
HTTP/1.1 204 No Content
```

No body, and no `Content-Length` header at all — not `Content-Length: 0`, an absence. `sendNoContent` calls `res.end()` with no argument, which guarantees it. The CORS preflight answer is also a 204: the headers *are* the entire response.

The rule of thumb: **200 when the body carries information the client does not have; 204 when the client already knows the outcome.** A `DELETE` that returned the deleted task would be a 200, because then the body would be saying something.

### 5.5 Why DELETE of a missing id is 404 here, not 204

A genuine design choice with a real trade-off, and both answers are defensible.

| Choice | What it buys | What it costs |
| --- | --- | --- |
| 204 for a delete of anything, present or not | `DELETE` is trivially idempotent: a retry after a dropped connection gets the same answer as the first attempt | A client deleting an id from a typo, a stale cache or a bug never finds out. The mistake is silently absorbed |
| 404 when the id was not there (this project) | Genuine client bugs surface immediately, in development and in logs | A client retrying a delete must understand that 404 means "already gone" |

First, a clarification that is easy to get wrong: **a 404 does not make `DELETE` non-idempotent.** RFC 9110 defines idempotency as a property of the *effect on the server*, not of the response. Whether the second delete answers 204 or 404, the resource is absent afterwards, so retries are still safe.

The choice is therefore purely about information: who should learn that the id was wrong? This project decided the client should, because a silent 204 makes a typo indistinguishable from a success, and that is the class of bug hardest to find later. The implementation needs no separate existence check:

```ts
const removed = store.delete(id);
if (!removed) {
  throw new NotFoundError(`No task exists with id "${id}".`);
}
```

`Map.delete` already reports whether anything was removed, which also avoids a check-then-delete race.

**Client guidance:** treat a 404 on a `DELETE` you initiated as "it was already gone" and continue. Do not treat it as a retry failure, and do not retry hoping for a 204 — no number of retries will produce one.

## 6. Every failure mode in this API, in one table

| # | Trigger | Status | `code` | Detected in |
| --- | --- | --- | --- | --- |
| 1 | Path segment has a malformed percent-escape (`/api/tasks/%zz`) | 400 | `BAD_REQUEST` | `matchSegments` in `src/router.ts`, around the `decodeURIComponent` call |
| 2 | No route matches the path | 404 | `NOT_FOUND` | `Router.dispatch` in `src/router.ts` |
| 3 | Path matches but the method is not registered | 405 | `METHOD_NOT_ALLOWED` | `Router.dispatch` in `src/router.ts`, which builds the `allowed` list |
| 4 | Declared `Content-Length` exceeds the limit | 413 | `PAYLOAD_TOO_LARGE` | `readRawBody` in `src/http/request.ts` |
| 5 | Streamed body exceeds the limit (chunked, or a lying `Content-Length`) | 413 | `PAYLOAD_TOO_LARGE` | `readRawBody` in `src/http/request.ts` |
| 6 | Body is empty or whitespace only | 400 | `BAD_REQUEST` | `readJsonBody` in `src/http/request.ts` |
| 7 | Body present but `Content-Type` missing or not a JSON media type | 415 | `UNSUPPORTED_MEDIA_TYPE` | `readJsonBody` in `src/http/request.ts`, via `isJsonMediaType` |
| 8 | Body is not valid JSON | 400 | `BAD_REQUEST` | `readJsonBody` in `src/http/request.ts`, in the `catch` around `JSON.parse` |
| 9 | Body is valid JSON but not an object (string, number, array or `null`) | 422 | `VALIDATION_FAILED` | `requireJsonObject` in `src/validation/task.validation.ts`, against field `(body)` |
| 10 | Body contains an unknown field (for example `titel`) | 422 | `VALIDATION_FAILED` | `rejectUnknownFields`, reached from `parseTaskWriteInput` and `parseTaskUpdateInput` |
| 11 | `title` missing on POST/PUT, not a string, empty or whitespace only, or over 200 characters | 422 | `VALIDATION_FAILED` | `readTitle` via `parseTaskWriteInput`, in `src/validation/task.validation.ts` |
| 12 | `description` is not a string or `null`, or over 2000 characters | 422 | `VALIDATION_FAILED` | `readDescription` via either body parser |
| 13 | `priority` is not one of `low`, `medium`, `high` | 422 | `VALIDATION_FAILED` | `readPriority` via either body parser |
| 14 | `completed` is present but not a boolean | 422 | `VALIDATION_FAILED` | `readCompleted` via either body parser |
| 15 | PATCH body contains no updatable field (`{}`) | 422 | `VALIDATION_FAILED` | `parseTaskUpdateInput` in `src/validation/task.validation.ts`, in the empty-patch check |
| 16 | `?limit=`/`?offset=` not a whole number in range; `?completed=` not `true`/`false`; `?priority=` unknown; unknown query parameter | 400 | `BAD_REQUEST` | `parseTaskListQuery` in `src/validation/task.validation.ts`, integer params via `readIntegerQueryParam` |
| 17 | `GET /api/tasks/:id` for an id that does not exist | 404 | `NOT_FOUND` | `TaskStore.findById` returns `undefined`; the handler in `src/routes/tasks.routes.ts` throws |
| 18 | `PUT /api/tasks/:id` for an id that does not exist | 404 | `NOT_FOUND` | `TaskStore.replace` returns `undefined`; the handler throws |
| 19 | `PATCH /api/tasks/:id` for an id that does not exist | 404 | `NOT_FOUND` | `TaskStore.update` returns `undefined`; the handler throws |
| 20 | `DELETE /api/tasks/:id` for an id that does not exist | 404 | `NOT_FOUND` | `TaskStore.delete` returns `false`; the handler throws |
| 21 | A route parameter is absent at runtime (a route-registration bug) | 500 | `INTERNAL_ERROR` | `requireParam` in `src/http/context.ts` |
| 22 | Anything else thrown or rejected: a `TypeError`, a failed dependency, a bare string | 500 | `INTERNAL_ERROR` | `toHttpError` in `src/middleware/errorHandler.ts` |
| 23 | An error raised after the response has started | no status | — | `createErrorHandler` in `src/middleware/errorHandler.ts` calls `res.destroy()` |

Two footnotes. Rows 17–20 are the layer split from section 3: the *store* determines that the task is missing, the *handler* decides that means 404. And not every error in the codebase is an HTTP error — `Router.add` throws a plain `Error` for a route path that does not start with `/` or that declares a parameter name twice, and `src/config.ts` throws plain `Error`s for malformed environment variables. Those happen **at startup**, before any request exists, and they crash the process on purpose, because a configuration mistake should be loud and immediate rather than a runtime surprise. They never become responses and so never appear above.

Rows 1–20 are the client's fault and are normal traffic. Only rows 21 and 22 are problems with the server itself.

### The vocabulary on the wire

These are real responses from this API, shown verbatim so there is no ambiguity about the shape:

| Request | Response |
| --- | --- |
| `POST /api/tasks` with body `{"title":` | `400` — `{"error":{"code":"BAD_REQUEST","message":"The request body is not valid JSON: Unexpected end of JSON input"}}` |
| `POST /api/tasks` with no body | `400` — `{"error":{"code":"BAD_REQUEST","message":"A JSON request body is required for this endpoint. This request had an empty body."}}` |
| `POST /api/tasks` with `Content-Type: text/plain` | `415` — `{"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"This endpoint requires a JSON request body. Send the header \"Content-Type: application/json\"."}}` |
| `PATCH /api/tasks` (the collection; PATCH is not a route there) | `405` with `Allow: GET, OPTIONS, POST` — `{"error":{"code":"METHOD_NOT_ALLOWED","message":"This URL does not support that method. Allowed methods: GET, OPTIONS, POST."}}` |
| `GET /api/tasks?limit=abc` | `400` — `{"error":{"code":"BAD_REQUEST","message":"One or more query parameters are invalid.","details":[{"field":"limit","message":"Must be a whole number between 1 and 100. Received \"abc\"."}]}}` |
| `GET /api/tasks/%zz` | `400` — `{"error":{"code":"BAD_REQUEST","message":"The URL contains an invalid percent-encoded escape sequence: \"%zz\"."}}` |
| `POST /api/tasks` with a 200,000-byte body (default limit 100,000) | `413` — `{"error":{"code":"PAYLOAD_TOO_LARGE","message":"The request body is larger than the 100000 byte limit."}}` |

## 7. Never leak internals

`InternalServerError` is deliberately generic:

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected internal error occurred."
  }
}
```

That genericness is not laziness; it is configured, and the switch is in [`src/app.ts`](../src/app.ts):

```ts
createErrorHandler({
  exposeInternalErrors: config.nodeEnv !== 'production',
}),
```

| `NODE_ENV` | `exposeInternalErrors` | 500 message sent to the client |
| --- | --- | --- |
| anything else (development is the default) | `true` | `An unexpected internal error occurred (TypeError: Cannot read properties of undefined (reading 'title')). This detail is only shown when NODE_ENV is not "production".` |
| `production` | `false` | `An unexpected internal error occurred.` |

On in development, because a learner staring at "Internal Server Error" with no detail loses an hour: the whole point of a local run is to see what broke. Off in production, because internal error messages routinely — not occasionally — contain things a client must not have.

| A real internal message | What it discloses |
| --- | --- |
| `Error: connect ECONNREFUSED 10.0.3.14:5432` | An internal host and port, and the existence of a PostgreSQL-shaped dependency |
| `SQLITE_ERROR: no such column: tasks.titel` | Database engine, table name, column names, and the shape of the schema |
| `TypeError: ... at TaskStore.create (C:\Users\aubre\Code\repos\personal\ac\dev_node-api\src\data\task.store.ts:141:22)` | Local file paths, source layout, dependency versions, library internals — a map of the system for anyone probing it |

Stack traces are the worst of these, because they are a gift to an attacker: they name the framework, the version, the file layout and often the exact weak line. A 500 response is not a debugging session with a stranger; it is a statement that the server failed, and nothing more.

### Two audiences, two messages

The resolution is to give the two audiences different information about the same failure:

| Audience | What they get | Why |
| --- | --- | --- |
| The client | A generic `INTERNAL_ERROR` message, no details, and a 500 status | They cannot act on a stack trace, and must not receive the internals |
| The server operator | The **original** error object, printed to the server console with its stack | They are the only one who can fix it, and they need everything |

That is why the handler logs the original value rather than the translated one:

```ts
if (httpError.status >= 500 && logServerErrors) {
  console.error(`[error] ${ctx.method} ${ctx.url.pathname} failed:`, error);
}
```

By this point `toHttpError` has already replaced the useful message with a generic one, so logging `httpError` would log the project's own boilerplate and the real stack would be gone forever. Passing `error` keeps `console.error` printing the full stack.

Two related details. **4xx errors are not logged here at all** — client mistakes are normal traffic, not incidents, and the access log already records them; logging every 422 as an error is how teams learn to ignore error logs. And **`details` is serialized straight to the client**, typed `unknown` and handed to the serializer without inspection, so the same rule applies: never put a secret, a file path or an internal identifier in it. One thing this API lacks: with the message generic, correlating a client's report with a server log line needs a request id echoed in both. The middleware pipeline is the right place to add one, as discussed in [08 — Next steps](08-next-steps.md).

## 8. Errors that happen after the response has started

Every response here is written in one call, after all the work is done: `sendJson` builds the whole body, then calls `writeHead` and `end`. That makes mid-response failures unlikely, but not impossible, and the handler must cope.

The problem is that an HTTP response is a stream of bytes with no going back. Once `writeHead` has run, the status line and headers are on the wire. Changing the status is not merely awkward, it is impossible: Node raises `ERR_HTTP_HEADERS_SENT`, and the client has already read and believed the original status line. So the handler checks first:

```ts
if (ctx.res.headersSent) {
  // The status line and headers are on the wire and cannot be taken back,
  // so there is no correct status code left to send.
  ctx.res.destroy();
  return;
}
```

`res.destroy()` closes the socket without completing the response. The client sees an incomplete read — a truncated body, or a connection ending with no terminating chunk in chunked framing — and reports a protocol error instead of a success.

| Option | What the client sees | Verdict |
| --- | --- | --- |
| Send the rest of a truncated body and end normally | A complete-looking response whose body is missing data or is not valid JSON, behind a 200 status line that says everything is fine | A lie, and an invisible one until something downstream breaks confusingly |
| Try to change the status with a second `writeHead` | Node throws `ERR_HTTP_HEADERS_SENT`; the original status line is sent regardless | Impossible |
| Destroy the socket | An explicit transport-level failure that any competent HTTP client surfaces as an error | Correct |

Dropping the connection is the only signal left that is not misleading: the client's parser notices the message ended early, and the failure is attributed to the transport where it belongs. A `Content-Length` that was declared but never fulfilled, or a chunked stream with no final zero-length chunk, is exactly the condition HTTP clients are built to detect.

The same guard appears in the last-resort `.catch` in `app.ts`, which also destroys rather than responding. In this project the branch is defence in depth rather than a routine path, precisely because nothing streams a body while it computes.

## 9. Only tolerate `unknown` in the catch

The catch clause carries an explicit annotation:

```ts
} catch (error: unknown) {
  const httpError = toHttpError(error, exposeInternalErrors);
```

That is not decoration. Under `strict` — which [`tsconfig.json`](../tsconfig.json) enables along with `noUncheckedIndexedAccess` and the rest — the caught binding is typed `unknown` rather than `any`. `unknown` means "a value of no known type": you cannot read a property off it, call it, or pass it where a specific type is expected until you have *proved* what it is. `any` would have let `error.status` and `error.message` compile, silently switching off checking for a value nobody has verified.

The annotation matters because JavaScript places no restriction on what can be thrown: a `new Error('normal')`, the string `'oops'`, the number `42`, `undefined`, any object at all, or a rejected promise whose reason is a string. There is no `throws` clause, no checked-exception mechanism and no runtime guard: a `catch` clause can receive literally anything, and TypeScript models that honestly as `unknown`. `toHttpError` is the one place that uncertainty is resolved:

```ts
function toHttpError(error: unknown, exposeInternalErrors: boolean): HttpError {
  if (error instanceof HttpError) {
    return error;                                  // deliberate, already has a status and code
  }
  if (!exposeInternalErrors) {
    return new InternalServerError();              // production: say nothing
  }
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new InternalServerError(`An unexpected internal error occurred (${detail}). ...`);
}
```

Three things follow:

1. **`instanceof HttpError` is the correct narrowing check.** It is a runtime prototype-chain test, and because the hierarchy is a set of native classes in one module, all seven subclasses satisfy it. Anything that does is guaranteed to have `status`, `code` and `details`, which is what the rest of the handler needs.
2. **`error instanceof Error` is the second check**, for the developer-facing detail string. It catches the ordinary `TypeError`/`RangeError` cases and gets a useful `name` and `message`; anything else falls back to `String(error)`, so the string `'oops'` at least shows up as `oops`.
3. **`catch (error: any)` is never correct here**, and neither is a `catch` followed by a cast. Both throw away the existence proof `instanceof` provides.

### The one caveat worth knowing about `instanceof`

`instanceof` compares prototype identity, not shape: a value is an instance of *your* class only if its prototype chain contains the exact object your class reference points at. That fails in scenarios which do not arise here.

| Scenario | Why `instanceof` fails | Robust alternative |
| --- | --- | --- |
| The error crossed a `worker_threads` boundary, or passed through `structuredClone`/IPC | The value was serialized and rebuilt in another isolate, so it is plain data with no prototype link back to your class | Check a branded property: a `code` field with a validated shape, or a `Symbol.for('HttpError')` marker, since `Symbol.for` uses a cross-realm registry |
| The error came from a `vm` context, or a second copy of the module was loaded | Different realm, or a different class object with the same name | Same branded-property check |
| A library throws an object shaped like `{ status, code, message }` | Not an instance, so it becomes a 500 | Deliberate: untrusted look-alikes should not choose their own status code |

This project runs in a single realm with a single module instance and never serializes errors between threads. Checking a property would add a new failure mode — a look-alike object forging a status — in exchange for robustness against a case that cannot happen. **`instanceof` is right here; the branded-property technique is worth remembering for the day one of those scenarios becomes real.**

## 10. Common mistakes

| # | Mistake | Why it hurts | Do this instead |
| --- | --- | --- | --- |
| 1 | Returning `200 OK` with `{"error": ...}` in the body | Every generic client, cache, proxy and monitor treats 2xx as success. `response.ok` is `true`, the error is never surfaced, and the error-rate dashboard shows zero | Send the matching 4xx/5xx status. The status is the machine-readable verdict; the body is detail |
| 2 | Using 500 for problems the client caused | Monitoring pages the on-call for a user's typo, and honest 5xx signals get lost in the noise | Validate input and send 400/415/422. Reserve 500 for genuine server failures |
| 3 | Using 400 for everything | The client cannot tell "do not retry, your request was garbage" from "retry with valid data" | Keep 400 for unparseable requests, 415 for media types, 422 for failed rules — and hold the line |
| 4 | Leaking stack traces to clients | Discloses file paths, dependency versions and schema details, and points an attacker at the weak line | Send the generic message in production; log the original error with its stack on the server only |
| 5 | Swallowing errors in an empty `catch {}` block | The failure vanishes. The request may hang until it times out, and no log records anything | Handle it and respond, or rethrow so the error handler can. If you must catch, log the original error |
| 6 | Logging only the translated error and losing the original stack | The log says `InternalServerError: An unexpected internal error occurred.` — which you already knew — and the cause is gone forever | Log the original thrown value. `toHttpError` has already discarded the useful text |
| 7 | Forgetting the `Allow` header on a 405 | It is an RFC 9110 requirement, and the one thing that makes a 405 actionable: without it the client must guess which methods work | Carry `allowed` on `MethodNotAllowedError` and emit `Allow: GET, OPTIONS, POST` |
| 8 | Giving a 204 response a body, or a `Content-Length` | Clients and intermediaries disagree about whether to read the body; many discard it. A declared length on a bodiless response is a protocol contradiction | `sendNoContent` calls `res.end()` with no argument and sets no `Content-Length` |
| 9 | Using 200 for a create instead of 201 | The client cannot learn the new resource's URL, so it must guess the id or re-list the collection — the problem `Location` exists to solve | 201 plus `Location: /api/tasks/<id>`, and return the created task so no follow-up GET is needed |

A tenth, closely related to #6: **not separating client errors from server errors in the log.** This project logs 4xx in the access log only, and logs the original error only for `status >= 500`. That is what keeps the error channel meaningful — when everything is logged as an error, nothing is.

## 11. How to debug an error in this API

Work through this in order. Each step narrows the problem, and the first three cost one request.

### 1. Read the status code

| Status | Means |
| --- | --- |
| 400 | The request could not be parsed or decoded |
| 404 | Nothing at this URL, or no task with that id |
| 405 | The URL is real, the method is not. Check the `Allow` header |
| 413 | The body was too large. Check `MAX_BODY_BYTES` |
| 415 | The `Content-Type` was missing or not JSON |
| 422 | The data failed the rules. This is the one with useful `details` |
| 500 | Our bug, or a dependency failing. Go to step 5 |

A 4xx means the request is wrong; a 500 means the server is wrong. Nothing else needs to be inferred yet.

### 2. Read the `code`

The code identifies the exact throw site, because the vocabulary has only seven entries (section 6). `VALIDATION_FAILED` sends you to the validator, `PAYLOAD_TOO_LARGE` to `readRawBody`, `METHOD_NOT_ALLOWED` to `Router.dispatch`.

### 3. Read `details`

For a 422, `details` usually answers the question outright:

```json
{
  "field": "titel",
  "message": "Unknown field. This endpoint accepts: title, description, priority, completed."
}
```

That is the whole investigation: a typo in the field name, reported by the exact key the client sent. `details` is absent when there is nothing per-field to say, which is itself information.

### 4. Find the access log line

Every request produces exactly one line, from `createLogger` in [`src/middleware/logger.ts`](../src/middleware/logger.ts), in the format `method path status duration`:

```text
14:03:22.481 POST   /api/tasks 422 0.4ms
14:03:22.902 GET    /api/tasks/nonexistent-id 404 0.2ms
14:03:23.115 DELETE /api/tasks/3f2504e0-4f89-11d3-9a0c-0305e82c3301 204 0.3ms
```

The status here is the *final* status, because the logger sits outside the error handler (section 4). If you ever see a `200` beside a response you know was an error, that ordering has been broken — check the middleware array in `src/app.ts`.

### 5. For a 5xx, read the server console

The error handler prints the original error, with its stack, and only for 5xx:

```text
[error] GET /api/tasks failed: TypeError: Cannot read properties of undefined (reading 'title')
    at TaskStore.create (C:\Users\aubre\Code\repos\personal\ac\dev_node-api\src\data\task.store.ts:141:22)
    at TaskStore.seed (C:\Users\aubre\Code\repos\personal\ac\dev_node-api\src\data\task.store.ts:79:12)
    ...
```

That stack is the thing the client did *not* get, and it is why the two messages differ. If the line begins `[fatal]` instead of `[error]`, the exception escaped the pipeline entirely — that path should be unreachable, so treat it as a bug in the error handling itself.

### A worked loop

```bash
# Reproduce with the headers visible. The status line is the first thing you see.
curl -i -X POST http://127.0.0.1:3000/api/tasks \
  -H 'Content-Type: application/json' \
  --data '{"title":"","titel":"oops"}'
```

```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/json; charset=utf-8

{"error":{"code":"VALIDATION_FAILED","message":"The request body failed validation.","details":[{"field":"titel","message":"Unknown field. This endpoint accepts: title, description, priority, completed."},{"field":"title","message":"Must not be empty or whitespace only."}]}}
```

The status says "the data is the problem", the code says "validation", and `details` names both faults. Fixing them and resending produces `201 Created` with a `Location` header naming the new task.

Two traps worth knowing: a 415 with a body you are sure is JSON is almost always the header, not the body, because `curl --data` sends `application/x-www-form-urlencoded` unless you pass `-H 'Content-Type: application/json'`. And a 400 from a URL containing `%` is percent-encoding: a literal `%` must be sent as `%25`.

## Further Reading

- [HTTP and REST Fundamentals](./01-http-and-rest-fundamentals.md) — the status class system, the `400`/`422` split, and the full meaning of `Content-Type`, `Location` and `Allow`
- [TypeScript for JavaScript Developers](./02-typescript-for-javascript-developers.md) — `unknown` versus `any`, narrowing with `instanceof`, classes and inheritance, and why `erasableSyntaxOnly` shapes the constructors in `src/http/errors.ts`
