# Node, the Runtime, and the `node:http` Module

Everything in `src/` ultimately reduces to two things: a function Node calls when a request
arrives, and the `req`/`res` objects it passes that function. Once those make sense, the rest of
this project stops looking like magic.

If you have only written JavaScript in a browser, much of this is genuinely new. Node is not
"JavaScript with extra libraries." It is a different host for the same language, with a different
architecture underneath.

## 1. What Node.js is

JavaScript is a language. A language alone does nothing — it needs a **runtime** that parses it,
compiles it, and provides the APIs a program can call. The language specification describes
`Array.prototype.map` and `JSON.parse`. It says nothing about files, sockets, or timers, because
those are not language features; they are host APIs.

You have been using one runtime all along: the browser. `document`, `window`, `localStorage`, and
`XMLHttpRequest` are not JavaScript. They are the browser's API surface, injected into your program
by the host environment. Node is a second runtime for the same language: it uses V8 — the same
engine Chrome uses — and adds an entirely different set of host APIs.

| Capability | Browser | Node |
| --- | --- | --- |
| Manipulate the page | `document`, DOM | not available |
| Read and write files | no (sandboxed) | `node:fs` |
| Raw TCP and UDP sockets | no (except WebSocket) | `node:net`, `node:dgram` |
| Run an HTTP *server* | no | `node:http` |
| Spawn child processes | no | `node:child_process` |
| Read OS signals and process info | no | `process`, `node:os` |
| Timers, Promises, `fetch` | yes | yes |

Node is the runtime you use when a program needs to be a *peer* on the network or a *citizen* of the
operating system, rather than a guest inside a tab.

### There is no `window`

`window` is the browser's global object: the root that `document`, `location`, and `history` hang
from. Node has no window and no `document`, because there is no page:

```bash
node --eval "console.log(typeof document, typeof window)"
# undefined undefined
```

Code written for the browser that reaches for those globals fails in Node — a common first surprise
when someone tries to use a browser library on a server.

What both runtimes share is `globalThis`, the standardized name for "the global object of whatever
runtime I am in." In a browser `globalThis === window`; in Node it is Node's own global. It exists so
portable code has one name for the global scope without guessing the host. (Node's older alias
`global` still works, and `globalThis === global` is `true` in Node 24.)

### The `node:` prefix

Every built-in is importable two ways, and this project always uses the prefix:

```ts
import { createServer } from 'node:http';      // this project
import { createServer as legacy } from 'http'; // also works
```

**It is unambiguous.** `'http'` could in principle resolve to an npm package named `http`. Node
reserves the `node:` prefix for its own built-ins, so `'node:http'` can never be shadowed. **And it
is self-documenting:** `import { randomUUID } from 'node:crypto'` tells you immediately that this is
a platform API and not a dependency — the whole point of a project with zero runtime dependencies.

## 2. The event loop and the single thread

**Node runs your JavaScript on exactly one thread.** Not a pool of JavaScript threads. One. Every
handler, callback, and middleware here runs on the same thread, one after another. There is no
parallelism in your code — but there is *concurrency*, and the difference matters.

### What one thread means concretely

**Your code is never interrupted mid-function.** JavaScript has no preemption. Control can only move
to other work when *you* return or `await`, so ordinary variable assignments are atomic with respect
to your own code and no other request can observe a half-finished object.

**Two request handlers never run literally at the same time.** They interleave at `await` points:
handler A runs until it awaits, B gets a turn, then A resumes when its promise settles. From outside,
requests look parallel; internally, the thread does one thing at a time.

This is why [task.store.ts](../src/data/task.store.ts) can use a plain `Map` with no locks, mutexes,
or transactions. No two operations on that `Map` can overlap on a single thread. On a
thread-per-request runtime, that file would be full of data races.

**The cost: a CPU-bound loop blocks everything.** A function that computes for two seconds without
awaiting stops the *entire* server for two seconds — not just its own request, but `/health` too.
Incoming connections pile up unread in the OS accept queue. There are no locks in Node because there
is no concurrency inside your code; the flip side is that no scheduler will save you from a long
computation.

### The phases

The loop runs in phases: **timers** (callbacks whose time elapsed), **pending callbacks** (a few
deferred system-level callbacks), **poll** (the main one — retrieve new I/O events and run their
callbacks), **check** (`setImmediate`, right after poll), and **close** (close events, such as a
socket's `'close'` handler). Each pass is one tick. The precise ordering is subtle and you should not
build application logic on it; what matters is that the loop decides what runs next, and that when it
has nothing left — no timers, no open handles, no pending I/O — the process exits. That is why
`unref()` in Section 10 matters.

### `libuv`, and why `await` does not block

Beneath the JavaScript sits `libuv`, the C library providing the event loop and the platform
abstractions Node is built on. POSIX and Windows expose most *network* I/O asynchronously — the OS
tells you when a socket is readable. They do not expose everything that way: filesystem operations,
DNS lookups, and some crypto are, in many cases, only blocking system calls.

`libuv` handles that with a small internal **thread pool** (four threads by default). Work with no
asynchronous OS equivalent is handed to a pool thread, which blocks there, and the main thread is
notified when it finishes. That resolves the apparent contradiction:

```ts
// Does NOT block the event loop. The read happens on a libuv pool thread;
// this thread stays free to serve other requests.
const text = await readFile('./data.json', 'utf8');

// DOES block the event loop. No await, so no other request is handled until
// this finishes -- seconds of total server downtime.
let total = 0;
for (let i = 0; i < 1_000_000_000; i++) total += i;
```

Both are "slow things in a handler." Only the second is a bug. The body-collection loop in
[request.ts](../src/http/request.ts) is the good kind: each iteration awaits the arrival of a chunk,
and between chunks the loop runs other requests. A thousand simultaneous uploads do not need a
thousand threads. Node is excellent at **I/O-bound** concurrency and poor at **CPU-bound** work on the
request path; for heavy computation, move it to `node:worker_threads`, a child process, or another
service.

## 3. `node:http` — the module

Node ships an HTTP/1.1 server that is not a framework. It does not route, parse JSON, or handle CORS.
It implements the protocol and hands you two objects. Everything else here —
[router.ts](../src/router.ts), the middleware in [src/middleware/](../src/middleware), the helpers in
[src/http/](../src/http) — is built on top.

### `createServer` and the listener

```ts
import { createServer, type RequestListener } from 'node:http';

const listener: RequestListener = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('hello');
};

const server = createServer(listener);
```

At this moment **nothing is listening** — no port is bound and no connection can arrive. You have an
object that knows which function to call when one does. That function is invoked once per HTTP
request, with `req: IncomingMessage` (a readable stream) and `res: ServerResponse` (a writable stream).

The listener returns `void`, but this project's listener is async internally: it kicks off
`pipeline(ctx)` and attaches a `.catch(...)`. Node does not await that promise and does not care about
it — Node's contract is only "call this function; a response will eventually be written." That is why
[app.ts](../src/app.ts) must handle the rejection itself. An unhandled rejection terminates the process
by default, so one malformed request could otherwise kill the server.

### `server.listen`, `address()`, `EADDRINUSE`, and port 0

```ts
server.listen(3000, '127.0.0.1', () => console.log('listening'));
```

**Binding a port is asynchronous.** `listen` returns immediately; the OS claims the port, and only then
does Node invoke the callback. Any code assuming the server is up *before* that callback is wrong,
which is why [server.ts](../src/server.ts) prints its banner inside it.

The `host` argument is the interface to bind: `'127.0.0.1'` is loopback-only (this project's default),
while `'0.0.0.0'` is all interfaces and reachable from the network. Omitting the host binds all
interfaces — a common way to accidentally expose a development server.

Once listening, `address()` reports what was *actually* bound: `null` before binding, a `string` for a
Unix socket or Windows named pipe, or `{ address, family, port }` for TCP. Every caller must narrow it.
[server.ts](../src/server.ts) does so to print the real port;
[testServer.ts](../tests/helpers/testServer.ts) throws if the result is not a TCP address.

Start the server twice and the second fails — not by throwing from `listen`, but as an `'error'` event,
because binding is asynchronous:

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:3000
```

The port is already claimed, usually by a previous run you backgrounded and forgot.
[server.ts](../src/server.ts) registers `server.on('error', ...)`, prints the exact PowerShell command
to find the culprit, and sets `process.exitCode = 1` rather than calling `process.exit(1)` immediately
(Section 10 explains why).

**Port 0** is the escape hatch: "operating system, choose any free port." You read it back from
`server.address()`. That is how every test runs — [testServer.ts](../tests/helpers/testServer.ts) calls
`server.listen(0, '127.0.0.1', resolve)`, so suites can run in parallel without fighting over 3000 and
nothing on your machine can be in the way. [config.ts](../src/config.ts) deliberately allows `PORT=0`
for this reason.

### `IncomingMessage` — the request

`req` is a **Readable stream** plus request metadata. The metadata is available immediately, before
any body bytes arrive, because it all comes from the request line and headers:

| Property | Meaning |
| --- | --- |
| `req.method` | `'GET'`, `'POST'`, ... Uppercase. Typed optional, hence `?? 'GET'` in [context.ts](../src/http/context.ts) |
| `req.url` | The **request target only** — see below |
| `req.headers` | Lowercased names: `req.headers['content-type']`, never `['Content-Type']` |
| `req.httpVersion` | `'1.1'` |
| `req.socket` | The underlying TCP socket |

**`req.url` is not a full URL.** HTTP/1.1 does not send an absolute URL; it sends a path:

```http
GET /api/tasks?limit=10 HTTP/1.1
Host: 127.0.0.1:3000
```

So `req.url` is the string `'/api/tasks?limit=10'` — no scheme, no host, no port. `new URL(req.url)`
therefore throws `Invalid URL`, because the constructor needs an absolute URL or a base. The base comes
from the **`Host` header**, mandatory in HTTP/1.1 for exactly this reason: it is what makes virtual
hosting possible. [context.ts](../src/http/context.ts) resolves it:

```ts
const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
// url.pathname                  -> '/api/tasks'
// url.searchParams.get('limit') -> '10'
```

The `?? 'localhost'` covers HTTP/1.0 and hand-written test clients, which may omit `Host`; the fallback
is never used for routing, only to satisfy the parser, so any value works. Using the platform `URL`
class rather than splitting on `'?'` means percent-decoding, query parsing, and the awkward edge cases
are handled by code tested far more than yours.

**Headers are lowercased** because HTTP header names are case-insensitive; Node normalizes once and
lets you index with the lowercase form. **And there is no `req.body`** — the body is the readable side
of the stream (Section 4).

### `ServerResponse` — the response

| Member | Purpose |
| --- | --- |
| `res.statusCode` | Defaults to `200`. Set before headers flush |
| `res.setHeader(name, value)` | Set one header. Sends nothing yet |
| `res.writeHead(status, headers?)` | Set status and a set of headers |
| `res.write(chunk)` / `res.end(chunk?)` | Write the body, then finish |
| `res.headersSent` | `true` once status line and headers are on the wire |
| `res.destroy()` | Tear the socket down immediately |

There is a point of no return: the moment headers flush (first `write`, or `end`, or a filled buffer).
After that `setHeader` throws `ERR_HTTP_HEADERS_SENT` and the status code is already on the wire. Both
places here that might fail late check the flag first:

```ts
// src/middleware/errorHandler.ts
if (ctx.res.headersSent) {
  // Status line already on the wire; there is no correct status code left to
  // send, so the honest signal is to drop the connection.
  ctx.res.destroy();
  return;
}
```

A destroyed socket tells the client the response was truncated. Sending a `500` after a `200` already
flushed would be a lie the client cannot detect. The same reasoning appears in
[app.ts](../src/app.ts) for the last-resort pipeline catch.

### `setHeader` merges with `writeHead`

**`res.writeHead(status, headers)` does not replace headers set with `res.setHeader(...)`. It merges
them, and the object passed to `writeHead` wins on conflicts.**

```ts
res.setHeader('Access-Control-Allow-Origin', '*');   // CORS middleware, early

// ... many pipeline layers later, in the handler ...
res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

// The client receives both headers.
```

Trace the flow: [cors.ts](../src/middleware/cors.ts) runs early and calls `res.setHeader` for the CORS
headers, then awaits `next()`, which runs the router and eventually the handler. In there,
[sendJson](../src/http/response.ts) calls `res.writeHead(...)`. The CORS headers survive, because the
middleware set them on the response object itself rather than on a per-call options bag. Had
`writeHead` replaced the header set wholesale, they would vanish the moment a handler responded, and
the only symptom would be browsers reporting opaque network errors. That merge is what makes
"middleware runs before the handler" useful for response headers — and it lets a caller override,
since the spread in [response.ts](../src/http/response.ts) comes last.

### Why there is no `req.body`

Every framework's `req.body` is the same trick: read the stream to completion, parse it, assign it to
the request. Express ships this as `express.json()`, which is bundled `body-parser`, and it does
approximately what `readJsonBody` in [request.ts](../src/http/request.ts) does. The difference is that
`req.body` is typed `any`, which is why `readJsonBody` returns `unknown` instead — forcing the caller
to prove the shape, which is what [task.validation.ts](../src/validation/task.validation.ts) does
next.

## 4. Why the body arrives as a stream

`createServer` calls your listener as soon as the request line and headers are parsed. The body has
not arrived — it may not have been sent yet, may be 100 MB, may take a minute, may arrive in one
packet or fifty. So Node gives you the body as a readable stream, with bytes arriving as `'data'`
events you choose to consume:

```ts
const chunks: Buffer[] = [];
req.on('data', (chunk) => chunks.push(chunk));
req.on('end', () => { /* all bytes are here */ });
req.on('error', (err) => { /* aborted, reset, ... */ });
```

This works and is what body parsers did for years. It is also four pieces of state to keep in sync,
and easy to forget the error case. Node implements the **async iterator protocol** on streams, which
allows the same thing as a loop — what this project uses.

### `readRawBody`, step by step

From [request.ts](../src/http/request.ts):

```ts
const declaredLength = Number.parseInt(req.headers['content-length'] ?? '', 10);
if (Number.isInteger(declaredLength) && declaredLength > maxBytes) {
  throw new PayloadTooLargeError(maxBytes);   // reject before transferring a byte
}

const chunks: Buffer[] = [];
let receivedBytes = 0;

for await (const chunk of req) {
  const buffer = chunk as Buffer;
  receivedBytes += buffer.byteLength;
  if (receivedBytes > maxBytes) throw new PayloadTooLargeError(maxBytes);
  chunks.push(buffer);
}

return Buffer.concat(chunks).toString('utf8');
```

**The cheap check first.** If the client announced `Content-Length: 999999999`, there is no reason to
accept a single byte. `Number.parseInt('', 10)` is `NaN` and `Number.isInteger(NaN)` is `false`, so a
missing or malformed header simply skips this check — intended behavior, since the header is optional.

**The loop** pulls chunks as they arrive, and the counter enforces the real limit because the announced
length can be absent or wrong. An unbounded buffer is a one-line denial of service: a server that
concatenates whatever it is sent will read 10 GB into memory and be killed by the OOM killer.

**Accumulate Buffers, decode once.** Not stylistic — Section 5 explains why it is required.

### `Content-Length` versus chunked

**With a length**, the client knows the size and says so:

```http
POST /api/tasks HTTP/1.1
Content-Type: application/json
Content-Length: 47

{"title":"Write the docs","priority":"high"}
```

The server knows how many bytes to expect and where the body ends. This is what
[response.ts](../src/http/response.ts) produces for every response: it holds the serialized string, so
it computes the byte count with `Buffer.byteLength` and declares it.

**Chunked** is for when the producer does not know the size up front — or is streaming: a series of
length-prefixed chunks (`2f` is the hex length, `0` terminates) under `Transfer-Encoding: chunked`,
with no `Content-Length` at all. Node decodes the framing and hands you
payload bytes as a normal stream, so your code does not care — but `req.headers['content-length']` is
`undefined`, which is why the top-of-function check cannot be the only limit. **The announced length is
a claim by the client**, unverified before the body arrives: someone sending `Content-Length: 5`
followed by 500 MB passes the header check, and the loop is the only thing between your process and the
OOM killer. Enforcement belongs where the bytes are; the header check is an optimization, not a
security control.

### Backpressure

Backpressure is what happens when a producer makes data faster than a consumer handles it. Node's
answer is to stop reading from the socket until the consumer is ready, and resume after. The manual
mechanism is `req.pause()` and `req.resume()`. While paused, data stays in the kernel receive buffer
and TCP flow control eventually tells the sender to slow down — memory stays flat instead of growing
without bound.

The `'data'`-event style requires you to manage this yourself: attaching a `'data'` handler puts the
stream in flowing mode, pushing chunks as fast as they arrive, so a slow handler queues them in memory.
**The async iterator does this for you.** `for await (const chunk of req)` is pull-based: the loop asks
for the next chunk, and between iterations the stream is effectively paused. If the body contains
`await` calls that take time, the socket stops being read during them. Strictly, the iterator alone is
not a complete defense — a `for await` loop whose body never awaits can still outrun a slow consumer —
and `maxBytes` is what bounds memory here.

## 5. Buffers and encodings

`Buffer` is a subclass of `Uint8Array` for raw binary data: a **fixed-length view over a sequence of
bytes**. It is not a string, has no character semantics, and is not iterated by character. This
matters the moment your data leaves ASCII:

```js
Buffer.byteLength('é', 'utf8'); // 2   ('é' is U+00E9 -> bytes 0xC3 0xA9)
'é'.length;                      // 1

Buffer.byteLength('😀', 'utf8'); // 4   (astral character)
'😀'.length;                     // 2   (two UTF-16 code units)
```

**`Content-Length` must be a byte count**, because it describes the size of the body *on the wire*,
and the wire carries bytes. Writing `String(payload.length)` for a response containing an accented
character under-declares the length, and the client reads a truncated body — or hangs waiting for
bytes that a following request would supply. The bug is intermittent, appearing only for non-ASCII
payloads. [response.ts](../src/http/response.ts) gets it right by measuring bytes and writing the same
object it measured, so declared and actual length cannot drift:

```ts
const payload = JSON.stringify(body);
const bytes = Buffer.from(payload, 'utf8');

res.writeHead(status, {
  'Content-Type': JSON_CONTENT_TYPE,
  'Content-Length': String(bytes.byteLength),
});
res.end(bytes);
```

The three `Buffer` operations used here are **`Buffer.from(string, 'utf8')`** to encode,
**`Buffer.concat(chunks)`** to join an array of buffers, and **`buffer.toString('utf8')`** to decode.

### Why we concatenate Buffers, not strings

A multi-byte UTF-8 character can straddle a chunk boundary. If the body ends with `é` and TCP splits
it right there, decoding each chunk independently and concatenating the *strings* destroys the
character, because each half is an invalid sequence on its own:

```js
Buffer.from([0xC3]).toString('utf8'); // '\uFFFD'  (replacement character)
Buffer.from([0xA9]).toString('utf8'); // '\uFFFD'
// result: '\uFFFD\uFFFD' -- the 'é' is gone

Buffer.concat([Buffer.from([0xC3]), Buffer.from([0xA9])]).toString('utf8'); // 'é'
```

**Rule: buffer bytes, decode once at the end.** Chunk boundaries are an artifact of packetization and
TCP, not a property of your data — arbitrary byte sequences are split at arbitrary points.

This is also why `req.setEncoding('utf8')` deserves care. It handles the boundary for you with a
stateful decoder, but hands you strings, defeating the byte counting `maxBytes` depends on, and
hiding what is happening. Accumulating Buffers is the honest version.

### The cast

```ts
const buffer = chunk as Buffer;
```

Node's stream types are generic over the chunk type, and for `IncomingMessage` it is `Buffer` in
practice, though the static type can be looser. The cast documents the expectation. If a chunk were
ever a string, `buffer.byteLength` would be `undefined` and `receivedBytes > maxBytes` would be
`NaN > maxBytes` — `false`, silently disabling the limit. This is a place to be suspicious of a cast
rather than reassured; wrapping with `Buffer.from(chunk)` would be safer.

## 6. CommonJS versus ES modules

Node has two module systems, and this project uses exactly one.

**CommonJS** — `require` and `module.exports`. Synchronous, dynamic, loadable at any point: `require`
is an ordinary function call, so it can sit inside an `if` or be computed from a variable. Resolution
happens at runtime, which is why no tool can reliably tell what a CommonJS file imports without
running it.

**ES modules** — `import` and `export`, the language-level system. These are **syntax**, not calls.
They are hoisted, and the module graph is determined *before* any code runs. That static analysis is
what makes tree shaking possible (a bundler can prove which exports are unused) and what makes
top-level `await` possible (evaluation can suspend while dependencies settle).

### `"type": "module"`

Node cannot tell which system a `.js` file uses until it parses it, so `package.json` decides:

```json
{ "type": "module" }
```

With this set, every `.js` file in the package is an ES module; without it, every one is CommonJS.
That is the whole switch, and it is why `npm start` running `dist/server.js` works — the compiled
JavaScript is ESM because the nearest `package.json` says so. An explicit extension overrides the
package default (`.cjs` is always CommonJS, `.mjs` always ESM), and a `.ts` file follows the same
rule as the corresponding `.js`, so under `"type": "module"` `src/server.ts` is ESM.

### Why ESM requires explicit extensions

CommonJS resolution guesses for you: `require('./router')` tries `./router.js`, `./router.json`,
`./router/index.js`, and so on. In an ESM package it does not. The specifier is used as-is, so
`import { Router } from './router'` fails with `ERR_MODULE_NOT_FOUND` while
`import { Router } from './router.ts'` works. There is no extension-guessing, no `index.js` fallback,
and no directory resolution for relative specifiers. (Bare specifiers like `'node:http'` go through
the package resolver, not the file resolver, so they are unaffected.) The reason is that ESM
resolution is designed to be unambiguous and to work over a network, where guessing would mean a
request per guess. That is why the imports here look the way they do:

```ts
// src/app.ts
import { config } from './config.ts';
import { Router } from './router.ts';
import { createCors } from './middleware/cors.ts';
import type { Middleware, RequestContext } from './types/http.ts';
```

### From `./router.ts` to `./router.js` on build

Node wants `.ts` in the source. The compiled output is `.js`, and `import './router.ts'` inside
`dist/app.js` would be broken — there is no `.ts` there. Two options in [tsconfig.json](../tsconfig.json)
bridge it:

```jsonc
"allowImportingTsExtensions": true,        // source may write './router.ts'
"rewriteRelativeImportExtensions": true,   // emitted JS gets './router.js'
```

So one source file works in both worlds: Node resolves `./router.ts` for real, and `tsc` rewrites the
specifier on the way out. [tsconfig.build.json](../tsconfig.build.json) inherits both, which is why
`dist/` gets correct specifiers.

### `import type`

`verbatimModuleSyntax` is enabled in [tsconfig.json](../tsconfig.json), so the compiler does not guess
which imports are types. Anything used only as a type must say so:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
```

This is required here because Node strips types without consulting TypeScript, and there is no
bundler to eliminate dead imports — an import that exists only for its types must be deleted by the
stripper, and `import type` marks it unambiguously. The practical consequence: an `import type`
statement produces **no runtime code at all**.

## 7. How Node runs TypeScript with no build step

```json
"dev": "node --watch --env-file-if-exists=.env src/server.ts"
```

Node 24 runs a `.ts` file directly — no `ts-node`, `tsx`, bundler, watcher library, or `dist/`.
Understanding *how* explains most constraints you will hit.

### Type stripping

Node parses the file with a TypeScript-aware parser, **deletes the type annotations**, and executes
the JavaScript that remains. The implementation is based on the Amaro/SWC type-stripping path. It is a
text-level operation: types are removed, nothing is generated.

```ts
function add(a: number, b: number): number { return a + b; }  // what you write
function add(a, b) { return a + b; }                          // what Node executes
```

The types are gone before V8 sees the code. There is no separate compile pass for a debugger to step
through and no source map to bridge, because what runs is a character-for-character subset of what you
wrote.

### It does not type check

Type stripping has no type checker: it does not resolve imports to read their types, does not build a
program, and does not report anything about your types. A file whose only problem is an erased type
runs perfectly. This file executes cleanly:

```ts
// bad.ts
const count: number = 'not a number';
console.log('this ran anyway, count =', count, typeof count);
```

```
$ node bad.ts
this ran anyway, count = not a number string
$ echo $?
0
```

Exit code 0. The annotation `: number` was deleted, `const count = 'not a number'` ran, and the lie was
never discovered. Compiling it with `tsc` would have produced `error TS2322: Type 'string' is not
assignable to type 'number'`.

**So the type checker is a separate step with a separate command:**

```bash
npm run typecheck   # tsc -p tsconfig.json -- checking only, no output
```

This is exactly why the project has both. `npm run dev` is fast and forgiving; `npm run typecheck` is
slow and strict, and belongs in CI or a pre-commit hook. The mental model: Node guarantees the file
**parses**, `tsc` guarantees the types **hold**, and only the first is on the path to getting your
server running.

### Only erasable syntax is allowed

Because stripping only *deletes* text and never *generates* code, any TypeScript syntax that would
require emitting new JavaScript is rejected at load time, with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`:

```
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
TypeScript enum is not supported in strip-only mode
```

| Rejected | Why it cannot be stripped |
| --- | --- |
| `enum Colour { Red }` | Compiles to an object with reverse mappings; deleting it deletes the feature |
| `namespace` / `module` with runtime code | Compiles to an IIFE assigning to a variable |
| Parameter properties — `constructor(private readonly store: TaskStore)` | Silently declares a field and assigns it; needs generated code |
| `import x = require('y')` | Legacy interop that needs generated `require` calls |

Everything that erases cleanly is supported: type annotations, interfaces, type aliases, `import type`,
generics, `as` casts, `satisfies`, non-null `!`, `readonly`, `abstract`,
`private`/`protected`/`public` on ordinary fields and methods, and purely-typing `declare`:

```ts
class Store {
  private readonly items: string[] = [];
  declare count: number;                       // erasable: no field is emitted
  getItems(): readonly string[] { return this.items; }
}
console.log(new Store().getItems());           // [] -- runs with no build step
```

This project stays entirely inside the erasable subset. [task.store.ts](../src/data/task.store.ts)
declares its `private readonly` fields explicitly in the class body rather than via parameter
properties, and [config.ts](../src/config.ts) uses `readonly` on interface properties.

### `erasableSyntaxOnly` enforces it at check time

A runtime-only rule is discovered when you run the file — which, in a handler, might be after a long
uptime. So [tsconfig.json](../tsconfig.json) turns the same restriction into a *compile* error:

```jsonc
"erasableSyntaxOnly": true
```

With this on, `tsc` rejects `enum`, parameter properties, runtime `namespace`, and `import =` before
you run anything. Node's rule and TypeScript's rule are the same rule, checked in both places: if
`npm run typecheck` passes, Node will parse every file. `isolatedModules` is enabled alongside it for
a related reason — it guarantees each file can be compiled without looking at any other, which is
exactly how Node loads them.

### Contrast with other toolchains

| Approach | How it works | Trade-off |
| --- | --- | --- |
| **Node type stripping** | Deletes annotations, runs the rest | Zero dependencies, no build; no type check, erasable syntax only |
| **`ts-node`** | Hooks CommonJS `require`, compiles in-process | Historically CommonJS-shaped; awkward ESM and configuration story |
| **`tsx`** | esbuild transforms on the fly | Fast and permissive; a dependency and a non-Node transform |
| **Bundler** (`esbuild`, `tsup`) | Full transform plus bundling | Handles aliases and downleveling; adds an artifact and a config file |
| **`tsc` build** | Real offline compilation to `dist/` | Slowest feedback; the only option for shipping without source |

Notice what each buys that stripping does not: `tsx` and bundlers handle path aliases and non-erasable
syntax, `ts-node` gives legacy interop, `tsc` produces a real artifact. This project needs none of
those.

### When you still want `npm run build`

`npm run build` runs `tsc -p tsconfig.build.json` and emits JavaScript into `dist/`. Reach for it when
**you must run on an older Node** (stripping is a Node 22.18+/24 feature, while `dist/` runs anywhere
supporting the `es2024` target); **you want to ship without source**; **your tooling wants
JavaScript**, such as a bundler or a container that installs only runtime files; or **you want the
build itself as a gate**, since `tsc` exits non-zero on a type error. `npm run typecheck` does the same
without writing files and is the cheaper choice.

## 8. `process`, and configuration from the environment

`process` is Node's global handle on the running program. The parts this project uses:

**`process.env`** — the environment, as `Record<string, string | undefined>`. [config.ts](../src/config.ts)
is the only file that reads it for configuration. Two consequences of that type: a variable that is
absent is `undefined`, never `''` (though `PORT=` in a `.env` file does produce an empty string, which
is why `readString` normalizes empty to "unset"); and **every value is a string**, so `process.env.PORT`
is `'3000'`, not `3000`. Spreading strings through the codebase is a reliable source of bugs, so
everything is parsed and validated once at startup into a typed `AppConfig` with `port: number`.

The other decision there is *failing loudly*. `Number('three-thousand')` is `NaN` and `readInteger`
throws on it; `LOG_REQUESTS=maybe` throws rather than silently defaulting. On a server, "fails at
startup with a clear message" beats "misbehaves subtly at 3 a.m."

**`process.version`** is the Node version string, used in the startup banner in
[server.ts](../src/server.ts): `v24.22.0`. **`process.uptime()`** is seconds since the process
started, useful in a health endpoint.

**`process.hrtime.bigint()`** is a **monotonic** clock returning nanoseconds as a `bigint`. Monotonic
means it only moves forward, unaffected by NTP adjustments, timezone changes, or daylight saving.
**`Date.now()`** is wall-clock time, which is what you want for "when did this happen" and the wrong
tool for "how long did this take," because the system clock can jump backwards and produce a negative
duration. [logger.ts](../src/middleware/logger.ts) demonstrates the distinction:

```ts
const startedAt = process.hrtime.bigint();
try {
  await next();
} finally {
  const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
  const elapsedMs = Number(elapsedNanoseconds) / 1_000_000;
}
```

Subtracting two `bigint` values gives exact nanosecond precision with no floating-point drift and can
never go negative. Note the `try`/`finally` with no `catch`: the logger records the attempt even when
the pipeline throws, and deliberately lets the error continue to the error handler.

### Why configuration comes from the environment

The same artifact runs everywhere with no edits; secrets never enter git; and it is how containers,
systemd, and CI runners already configure processes.

### `--env-file-if-exists=.env`

Historically you installed `dotenv` and called `dotenv.config()` at the top of your entry point. Node
now reads `.env` files natively. Two variants exist: `--env-file=.env` **fails** if the file is
missing, while `--env-file-if-exists=.env` — what this project uses — proceeds silently. The
`-if-exists` form is the right default because `.env` is optional here: every setting in
[config.ts](../src/config.ts) has a fallback, so a fresh clone that only runs
`npm install && npm run dev` works. The strict form would make that clone fail on startup.

The format is `KEY=value` lines with `#` comments. `.env.example` documents every supported variable
with its default and is **committed**; `.env` is **git-ignored** (`.env` in
[.gitignore](../.gitignore)). That split is the convention: `.env` holds per-machine values and
credentials, while `.env.example` documents which variables exist, so a new contributor learns the
configuration surface without anyone's secrets entering history.

```powershell
Copy-Item .env.example .env   # PowerShell
```

```bash
cp .env.example .env          # bash
```

Two caveats. An environment variable already set takes precedence over the same name in the `.env`
file. And inline variables are shell-specific: `PORT=3001 npm run dev` is bash syntax and does **not**
work in PowerShell, where the equivalent is `$env:PORT=3001; npm run dev`. [server.ts](../src/server.ts)
prints that hint in its `EADDRINUSE` message for exactly this reason.

## 9. `node --watch`

`node --watch` runs the process and watches the files it loads. When one changes on disk, Node **kills
the process and starts a new one** — a built-in replacement for `nodemon`, and why this project has no
watcher in its dev dependencies. Save a file, the server restarts, the next request uses the new code.
Related flags include `--watch-path=...`, `--watch-preserve-output`, and `--watch-kill-signal` (default
`SIGTERM`), none of which the project needs — though that default is worth noting given Section 10,
because it means `npm run dev` exercises your shutdown path on every save.

### A restart loses all in-memory state

This is the detail that makes `--watch` genuinely educational here. The task store is a `Map` in the
process heap ([task.store.ts](../src/data/task.store.ts)) — not a file, not a database, not shared
memory. A restart is a **new process** with a **new heap**:

```bash
curl -X POST http://127.0.0.1:3000/api/tasks \
  -H "Content-Type: application/json" -d '{"title":"Ship it"}'
curl http://127.0.0.1:3000/api/tasks     # your task is there

# Now touch any source file. The server restarts.

curl http://127.0.0.1:3000/api/tasks     # gone, back to the seeded tasks
```

Nothing is broken — the store does exactly what an in-memory store does, and
[task.store.ts](../src/data/task.store.ts) states the caveat plainly. But feeling it happen is worth
more than reading about it: **a restart is a new program, and a process's memory dies with it.**

### Not hot module reloading

`--watch` is a **process restart**, not HMR. HMR replaces a module inside the *running* process,
selectively preserving module state and often in-memory data, and can keep open connections. It is a
bundler-and-framework feature (Vite, webpack, and the frameworks built on them), and it exists because
rebuilding a browser application is slow and a page cannot simply restart without losing what the user
was doing. A Node server restarts in well under a second and has no UI state to preserve, so a full
restart is the honest, simpler mechanism — and you get correctness for free, because the new process
is exactly like a freshly deployed one.

## 10. The process lifecycle, and graceful shutdown

### Signals

**`SIGINT`** is sent when you press **Ctrl+C**. **`SIGTERM`** is the polite shutdown request, sent by
Docker on `docker stop`, by systemd, by Kubernetes, and by `node --watch` when restarting. It means
"finish what you are doing and exit," as opposed to `SIGKILL`, which the OS enforces immediately and
which no program can catch.

```ts
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

If you register nothing, the default action for both is to terminate immediately — bad for a server,
because it cuts every in-flight request mid-response and a client that sent a `POST` may never learn
whether it succeeded. Handlers let you take control of the sequence. A note on Windows: it has no true
`SIGTERM`. Registering the handler is harmless and correct for Linux and containers, where it matters.

### The three APIs, and why all three are needed

**`server.close(callback)`** stops accepting *new* connections and calls the callback once the server
has closed. Crucially it **waits for existing connections to end**, including idle keep-alive
connections sitting between requests. That last part is the trap: a browser or `fetch` client holds
its TCP connection open after a response, ready to reuse it. That connection is idle but open, so
`close` refuses to finish until the client hangs up or times out — possibly minutes. Your process
appears to hang on Ctrl+C, the port stays bound, and the next `npm run dev` fails with `EADDRINUSE`.

**`server.closeIdleConnections()`** closes connections that are *between* requests and therefore have
nothing in flight to lose. That is the precise tool for the keep-alive problem: `close` can finish
promptly without harming a request being served.

**`server.closeAllConnections()`** force-closes everything, including requests mid-flight. That is
destructive — the client sees a truncated response — so it is the hammer you use only after a grace
period expires.

[server.ts](../src/server.ts) uses all three, in order of increasing violence:

```ts
server.close((error) => {
  if (error !== undefined) {
    console.error('Error while closing the server:', error);
    process.exit(1);
  }
  console.log('Server closed cleanly. Goodbye.');
  process.exit(0);
});

server.closeIdleConnections(); // free the merely-idle, so `close` can finish

const forceExit = setTimeout(() => {
  console.warn(`Requests are still in flight after ${SHUTDOWN_GRACE_MS}ms. Closing them forcibly.`);
  server.closeAllConnections();
}, SHUTDOWN_GRACE_MS);

forceExit.unref();
```

Read as policy: *stop listening immediately, drop idle connections immediately, give real work ten
seconds, then cut it off.* A re-entrancy guard makes a second Ctrl+C immediate, because users expect
the second press to mean "now":

```ts
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    console.log(`\nReceived ${signal} again. Exiting immediately.`);
    process.exit(1);
  }
  shuttingDown = true;
  // ...
}
```

### `setTimeout(...).unref()`

Section 2 said the loop exits when it has no work: no timers, no open handles, no pending I/O. A
pending `setTimeout` **is** work — a live handle — so a ten-second timer keeps the process alive for
ten seconds even when everything else is done. `.unref()` tells Node: *do not count this handle when
deciding whether the loop is empty.* The timer still fires if the process is around when it expires,
but it will not by itself keep the process running. Without it, every shutdown would sit for the full
grace period with nothing useful left to do, because the loop would still see a pending timer.
`unref()` is the standard idiom for "this is a safety net, not a reason to stay alive" — you will see
it on keepalive timers, cache expiry, and health-check intervals for the same reason.

### `process.exitCode` versus `process.exit()`

**`process.exit(code)`** tears the process down immediately, in the current tick, and does not flush
pending output. `console.log` to a pipe is asynchronous on POSIX, so output written just before it can
be lost — maddening to debug, because the message you relied on is the one that vanished.

**`process.exitCode = 1`** sets the code reported when the process ends *naturally*, letting the loop
drain so pending writes flush. [server.ts](../src/server.ts) uses both deliberately: on a startup
error it sets `process.exitCode = 1`, because "that lets any pending output flush before the process
ends, which is why the message above is not occasionally swallowed," while inside the `close` callback
— where all I/O is genuinely finished — it calls `process.exit(0)`.

The rule: **`process.exitCode` on a failure path, `process.exit()` only once all I/O is done** — and in
a signal handler, only after `close` confirms the server is down. That is why the exit calls live
*inside* the callback rather than after it.

## 11. Keep-alive and connection reuse

HTTP/1.0 opened a new TCP connection per request. HTTP/1.1 made persistent connections the default: a
connection stays open after a response and can carry the next request. Clients that want to be explicit
send the header, and clients that want the old behavior send `Connection: close`:

```http
GET /api/tasks HTTP/1.1
Host: 127.0.0.1:3000
Connection: keep-alive
```

**Why it exists.** A TCP connection costs a three-way handshake before any application data flows,
plus a TLS handshake and key exchange on top for HTTPS. For request/response pairs measured in
milliseconds, that fixed cost can dominate. Reuse amortizes it across many requests and lets TCP's
congestion window grow, so the second request on a connection is typically faster than the first. This
is why browsers pool connections, and why `fetch` in Node keeps them alive after a response — in
[api.test.ts](../tests/api.test.ts), successive `fetch` calls may reuse the same socket.

**Why it makes shutdown trickier.** Every idle, open socket is a connection the server owns, and
`server.close()` waits for connections to end. An idle keep-alive socket has no reason to end — the
client is holding it precisely so it can send another request later. So "Ctrl+C, then wait for
connections to drain" can wait a long time, with the port bound throughout. That is the problem
`closeIdleConnections()` solves, and why [server.ts](../src/server.ts) notes that without it
`npm run dev` on Windows can leave the port held after Ctrl+C.

**Why it makes testing trickier.** The same problem appears in the suite.
[testServer.ts](../tests/helpers/testServer.ts) is explicit about it:

```ts
// `fetch` keeps connections alive in a pool after the response arrives.
// `server.close()` waits for every open connection, so without forcing
// them shut the test process would hang at the end.
close: async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
},
```

Order matters: close the connections, *then* await `close`. Reverse it and you wait on sockets nothing
will close. A test helper is also the one place where `closeAllConnections()` is the right first move
rather than a last resort — there is no real user whose request might be truncated.

## 12. Node's built-in test runner

```json
"test": "node --test \"tests/**/*.test.ts\"",
"test:single-process": "node --test --test-isolation=none \"tests/**/*.test.ts\""
```

Node ships a test runner and an assertion library, which is why `jest` and `mocha` are absent.

### `node:test` and `node:assert/strict`

- **`describe(name, fn)`** groups related tests; groups nest.
- **`it(name, fn)`** is one test. The function may be `async` and the runner awaits it, so a test
  fails if it rejects.
- **`before` / `after`** run once for the enclosing group; **`beforeEach` / `afterEach`** run around
  every test in the group.

[api.test.ts](../tests/api.test.ts) uses all of them for a coherent reason:

```ts
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

before(async () => { server = await startTestServer(); }); // one server per suite
after(async () => { await server.close(); });              // and one clean shutdown
beforeEach(() => { server.app.store.clear(); });           // fresh store per test
```

Starting and stopping a real HTTP server per test would dominate the runtime, so one server per suite
with a state reset in `beforeEach` is the right balance — and that reset is what stops the suite from
passing or failing depending on execution order.

Assertions come from `node:assert/strict`, and the `/strict` path matters: the non-strict
`node:assert` inherits legacy coercing comparisons, so `assert.equal('1', 1)` passes there. Always use
`/strict`.

```ts
assert.equal(actual, expected);     // strict equality
assert.deepEqual(actual, expected); // structural comparison
assert.ok(value);                   // truthy
assert.throws(fn, /message/);       // throws, message matches
```

On failure the runner reports the file, line, expected and actual values, and exits non-zero — which is
the entire contract a test framework needs to provide.

**What replaced Jest and Mocha:** `describe`, `it`, the hooks, mocking (`mock.fn()`, `mock.method()`),
fake timers (`mock.timers`), coverage (`node --test --experimental-test-coverage`), watch mode
(`node --test --watch`), and `expect(x).toBe(y)` / `expect(x).toEqual(y)` as `assert.strictEqual` /
`assert.deepStrictEqual`. No config file is needed. The swap is nearly transparent, and it removes an
enormous dependency tree: Jest pulls in hundreds of packages, all of them code you did not write
running in your build. You would still reach for Jest for snapshot testing, an existing suite,
browser-DOM testing via jsdom, or a team fluent in its matchers.

### Test file isolation

By default, `node --test` runs **each test file in its own child process**. That buys independent
module state (a fresh registry per file, so a module-level cache cannot leak across files — and the
`config` object here is built once per process, so with isolation every test file gets its own), no
`process.env` leakage, containment of a crashing file instead of a failed run, and real parallelism
across cores — which is where port 0 in [testServer.ts](../tests/helpers/testServer.ts) becomes
essential, since two suites starting servers at once must not collide. The cost is startup overhead:
each child pays Node's boot cost, negligible for a few files but not for hundreds of tiny ones.

### `--test-isolation=none`

`test:single-process` runs every file in a **single** process, sharing one module registry, one heap,
and one environment. (The flag is also spelled `--experimental-test-isolation=none`; the short form is
the current name.) You might use it to profile or debug, since one process means one thing to attach a
debugger to and one stack to read; to cut startup overhead on a large suite of small files; or to
reproduce an isolation bug, since if a test only fails in this mode, two files are sharing state they
should not — a real bug that default isolation was hiding.

What you lose is everything above: state leaks between files become possible, `process.env` mutations
are visible to the next file, a crash takes down the whole run, and execution order becomes
observable. It is a diagnostic mode; keep it out of CI.

### Integration tests without `supertest`

`supertest` exists to fire requests at a server without managing sockets. Since `fetch` is a global and
`node:http` can bind port 0, the same thing is a dozen lines in
[testServer.ts](../tests/helpers/testServer.ts):

```ts
const server = createServer(app.listener);
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);           // `once`, not `on`: a lingering listener
  server.listen(0, '127.0.0.1', resolve); // would swallow a later startup error
});
const address = server.address();
// ... baseUrl: `http://127.0.0.1:${address.port}`
```

and then ordinary `fetch` in the tests:

```ts
const response = await fetch(`${baseUrl}/api/tasks`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Write it' }),
});
assert.strictEqual(response.status, 201);
```

These tests exercise the real stack — real socket, real parsing, real headers, real middleware order —
which is what [api.test.ts](../tests/api.test.ts) is for. You would still want `supertest` if your app
is an Express instance, where `supertest(app)` needs no port at all, or for its fluent response
assertions.

## 13. What this project deliberately does not use

Each entry is a package that solves a real problem, replaced here by a platform feature. The point is
not that packages are bad — it is to make the platform's boundaries visible, so you later choose a
dependency knowing what it buys.

| Package | Replaced by | Why the built-in is enough here | When you would reach for the package |
| --- | --- | --- | --- |
| `express` | `node:http` + a hand-written router | Method-and-path matching is a few dozen lines ([router.ts](../src/router.ts)) and the middleware pipeline is 30 lines ([compose.ts](../src/middleware/compose.ts)); writing them teaches what a framework does | Many route features at once — nested routers, per-route middleware, view rendering, content negotiation — or a team that knows it |
| `nodemon` | `node --watch` | The requirement is "restart on file change," which Node does natively with no config and no dependency | Watching non-module files, custom restart commands, or restart hooks |
| `dotenv` | `--env-file-if-exists=.env` | Reading `KEY=value` lines is now a runtime flag, and the `-if-exists` variant covers the optional-file case | Variable interpolation, layered `.env.local` overrides, or another file format |
| `ts-node`, `tsx` | Native type stripping | Node 24 runs `.ts` directly, so the whole category is unnecessary | Non-erasable syntax, path aliases, or downleveling to an older target |
| `jest`, `mocha` | `node:test` + `node:assert/strict` | Describe/it, hooks, assertions, and per-file isolation are all in the standard library | Snapshot testing, a larger assertion or mocking ecosystem, browser-DOM testing, or an existing suite |
| `supertest` | Global `fetch` against a server on port 0 | `fetch` exists globally and port 0 removes port management, so the helper is ~30 lines | Testing an Express app without a port, or its fluent response assertions |
| `uuid` | `node:crypto`'s `randomUUID` | A cryptographically secure v4 generator is in the standard library | A specific version or format — v7 for sortable IDs, v5 for namespace-derived, or ULID/KSUID |
| `cors` | a ~40-line middleware ([cors.ts](../src/middleware/cors.ts)) | CORS is a few response headers plus an `OPTIONS` short-circuit, and writing it exposes that the *browser* enforces it | A dynamic origin allowlist, credential handling, or the full preflight matrix maintained by someone else |
| `body-parser` | `readJsonBody` ([request.ts](../src/http/request.ts)) | Stream reading, a size limit, and `JSON.parse` is ~30 lines, and doing it makes `req.body` stop being magic | Multiple body formats (urlencoded, multipart, XML), or battle-tested edge cases |
| `compression`, `helmet` | not used | Additive rather than structural, and out of scope for a learning API | In production: response compression and a hardened default header set |

Two deserve a note.

**`--watch` is not `nodemon` under a new name in every respect.** Both restart the process and both
therefore lose in-memory state. Node has no state-preserving equivalent, and that is fine — Section 9
explains why a restart is the right model for a server.

**The hand-written CORS middleware** is deliberately generous and simple. It sends
`Access-Control-Allow-Origin: *` by default, which is fine for local learning and wrong for anything
using credentials, since browsers reject `*` combined with credentials. It does get one easy-to-miss
detail right: it sets `Vary: Origin` when the allowed origin is not `*`, so a shared cache cannot
replay one origin's response to another. Real CORS has more corners than this file covers, and
[cors.ts](../src/middleware/cors.ts) says so in its own comments.

## Where to go next

- **Routing and middleware** — how [router.ts](../src/router.ts) turns a method and a `URL.pathname`
  into a handler, and how [compose.ts](../src/middleware/compose.ts) makes the onion model work on top
  of async functions.
- **Persistence** — replacing the `Map` in [task.store.ts](../src/data/task.store.ts), which is where
  the "state dies with the process" lesson stops being a curiosity.
- **Worker threads and clustering** — what to do when the single thread from Section 2 is the
  bottleneck, and why `cluster` is the wrong first answer now that `worker_threads` exists.
