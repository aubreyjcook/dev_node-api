# dev_node-api

A barebones RESTful API built directly on Node's built-in `node:http` module, written in TypeScript, for the purpose of **learning how REST APIs actually work**.

There is no framework here. No Express, no Fastify, no body parser, no router library, no test framework, no `ts-node`, no `nodemon`, no `dotenv`. **There are zero runtime dependencies.** What a framework would do for you, this project does in 20 source files — about 2,900 lines, over half of which are comments explaining the reasoning — so you can see all of it.

That is the entire point. Frameworks are wonderful, and you should use one on your next real project. But `router.get('/api/tasks', handler)` stays a magic incantation until you have written the thing underneath it once.

---

## Is this for you?

You will get the most out of this project if you:

- are comfortable with JavaScript — functions, objects, arrays, closures, `async`/`await`, `import`/`export`
- have **not** built a server or a REST API before
- are new to TypeScript, or have used it only lightly
- want to understand HTTP, status codes and REST rather than just cargo-culting them

You do **not** need any prior experience with Node, servers, databases or networking.

---

## What you will learn

| Area | What you will be able to explain afterwards |
|---|---|
| **HTTP** | What a request and response actually look like on the wire; methods, status codes and headers |
| **REST** | Resources, URLs as nouns, idempotency, statelessness, and where REST is a spectrum rather than a rulebook |
| **The Node runtime** | The event loop, why your JavaScript runs on one thread, streams, buffers, and why there is no `req.body` |
| **TypeScript** | How Node runs `.ts` files with no build step, why types are *erased* and not *checked* at runtime, and how `unknown` beats `any` |
| **Routing** | How a URL pattern like `/api/tasks/:id` becomes a function call, written from scratch |
| **Middleware** | The onion model: how ~30 lines let you wrap logging, error handling and CORS around every request |
| **Error handling** | One error vocabulary, one place that turns it into an HTTP response, and a status code for every failure |
| **Validation** | Why TypeScript's types cannot validate a request body, and how to do it properly by hand |
| **Testing** | Unit and end-to-end tests with Node's built-in test runner, no dependencies |

---

## Quick start

### 1. Check your Node version

This project needs **Node 24 or newer** (it runs TypeScript natively — see [below](#why-node-24)). If you use nvm, the version is pinned in `.nvmrc`:

```bash
nvm use
node --version    # should print v24.x.x or higher
```

### 2. Install

```bash
npm install
```

Only two development packages are installed: `typescript` (for type *checking*) and `@types/node` (the type definitions for Node itself). Nothing is installed at runtime.

### 3. Run it

```bash
npm run dev
```

```
  dev_node-api  listening on http://127.0.0.1:3000
  environment   development
  node          v24.22.0
```

### 4. Make your first request

In a second terminal:

```bash
curl.exe -i http://127.0.0.1:3000/api/tasks
```

<details>
<summary>On macOS or Linux, use <code>curl</code> without the <code>.exe</code>.</summary>

In Windows PowerShell, `curl` is an alias for `Invoke-WebRequest`, which is a completely different tool. You must type `curl.exe` to get the real curl. This trips up almost everyone following a curl tutorial on Windows — see [Troubleshooting](#troubleshooting).
</details>

You should get the four seeded sample tasks back:

```
HTTP/1.1 200 OK
Cache-Control: no-store
X-Content-Type-Options: nosniff
Access-Control-Allow-Origin: *
X-Total-Count: 4
Content-Type: application/json; charset=utf-8
Content-Length: 620

[{"id":"f7ac5960-ef8f-492e-90a1-56b178916057","title":"Read the HTTP and REST fundamentals chapter", ... }]
```

### 5. Read the code

Start with `src/server.ts`, then `src/app.ts`. Follow the imports. Every file explains not just what it does but *why*, and what the alternative would have been.

---

## The API at a glance

Base URL: `http://127.0.0.1:3000`. All request and response bodies are JSON. All data is in memory, so **restarting the server resets everything** to the four seeded tasks.

| Method | Path | Success | What it does |
|---|---|---|---|
| `GET` | `/health` | `200` | Liveness check: is the server up? |
| `GET` | `/api/tasks` | `200` | List tasks. Supports filtering and pagination. |
| `POST` | `/api/tasks` | `201` + `Location` | Create a task. |
| `GET` | `/api/tasks/:id` | `200` | Fetch a single task. |
| `PUT` | `/api/tasks/:id` | `200` | **Replace** a task. Omitted fields reset to defaults. |
| `PATCH` | `/api/tasks/:id` | `200` | **Update** some fields. Omitted fields are preserved. |
| `DELETE` | `/api/tasks/:id` | `204` | Delete a task. Response has no body at all. |

### A task looks like this

```json
{
  "id": "2164807c-1594-4d83-85a1-16b39c5f5b5b",
  "title": "Write the docs",
  "description": null,
  "priority": "high",
  "completed": false,
  "createdAt": "2026-10-16T19:33:07.262Z",
  "updatedAt": "2026-10-16T19:33:07.262Z"
}
```

- `id` — a UUID generated by the server. Clients never choose an id.
- `description` — `string` or `null`. `null` means "no description", which is different from an empty string.
- `priority` — one of `"low"`, `"medium"`, `"high"`. Defaults to `"medium"`.
- timestamps — ISO 8601, always UTC.

### Query parameters for `GET /api/tasks`

| Parameter | Values | Default | Notes |
|---|---|---|---|
| `completed` | `true` \| `false` | *unset* | Unset means "no opinion", not "false". |
| `priority` | `low` \| `medium` \| `high` | *unset* | |
| `limit` | `1`–`100` | `20` | |
| `offset` | `0`–`1000000` | `0` | |

The response body is a bare JSON array. The total number of *matching* tasks — before pagination — is in the `X-Total-Count` response header, which is what lets a client render "showing 20 of 137". Unknown query parameters are rejected with `400` rather than silently ignored.

### Try the whole lifecycle

**On macOS, Linux, or Git Bash** — `curl` with the JSON in single quotes:

```bash
# Create
curl -i -X POST http://127.0.0.1:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Read the docs"}'

# Replace it (PUT resets anything you leave out)
curl -i -X PUT http://127.0.0.1:3000/api/tasks/PASTE_ID_HERE \
  -H "Content-Type: application/json" \
  -d '{"title":"Totally replaced"}'

# Update one field (PATCH leaves everything else alone)
curl -i -X PATCH http://127.0.0.1:3000/api/tasks/PASTE_ID_HERE \
  -H "Content-Type: application/json" \
  -d '{"completed":true}'

# Delete
curl -i -X DELETE http://127.0.0.1:3000/api/tasks/PASTE_ID_HERE
```

**On Windows PowerShell** — write the body to a file and send that. It looks clumsier, but it is the only form that actually works, and the reason is worth knowing.

> **Inline JSON does not survive PowerShell.** Windows PowerShell 5.1 mangles the embedded double quotes when handing an argument to a native program, so *every* inline form fails: `-d '{"title":"x"}'`, `-d "{\"title\":\"x\"}"`, and putting the JSON in a variable first all arrive at the server as corrupt JSON, and you get a confusing `400` saying the body is not valid JSON. Writing the body to a file and using `--data-binary "@file"` avoids the argument parser entirely. (Use `curl.exe`, not `curl` — see [Troubleshooting](#troubleshooting).)

```powershell
# Create
Set-Content body.json '{"title":"Read the docs"}' -NoNewline
curl.exe -i -X POST http://127.0.0.1:3000/api/tasks `
  -H "Content-Type: application/json" `
  --data-binary "@body.json"

# Replace it (PUT resets anything you leave out)
Set-Content body.json '{"title":"Totally replaced"}' -NoNewline
curl.exe -i -X PUT http://127.0.0.1:3000/api/tasks/PASTE_ID_HERE `
  -H "Content-Type: application/json" `
  --data-binary "@body.json"

# Update one field (PATCH leaves everything else alone)
Set-Content body.json '{"completed":true}' -NoNewline
curl.exe -i -X PATCH http://127.0.0.1:3000/api/tasks/PASTE_ID_HERE `
  -H "Content-Type: application/json" `
  --data-binary "@body.json"

# Delete (no body, so no file needed)
curl.exe -i -X DELETE http://127.0.0.1:3000/api/tasks/PASTE_ID_HERE
```

> `GET` and `DELETE` requests have no body, so they work fine inline on every platform. It is only requests that *send* JSON that need care. [Chapter 07](docs/07-testing-the-api.md) covers this and the other PowerShell traps in detail, with a reusable helper function.

### Errors

Every failure uses the same envelope, so a client only has to learn one shape:

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

`code` is stable and machine-readable. `message` is for humans and may be reworded. `details` is present only when there is something structured to say — most often, a list of field-level problems. All of them are reported at once, so one round trip tells you everything that is wrong.

---

## Project structure

```
dev_node-api/
├── src/
│   ├── server.ts                  Entry point: create the HTTP server, listen, shut down cleanly
│   ├── app.ts                     Wires the store, routes and middleware into a request listener
│   ├── config.ts                  Reads and validates process.env once, at startup
│   ├── router.ts                  The hand-written router: method + path pattern -> handler
│   │
│   ├── types/
│   │   ├── task.ts                The task domain types (Task, TaskWriteInput, priorities...)
│   │   └── http.ts                RequestContext, RouteHandler, Middleware, NextFunction
│   │
│   ├── http/
│   │   ├── errors.ts              HttpError hierarchy: one class per status code
│   │   ├── request.ts             readJsonBody(): collect the body stream and parse it
│   │   ├── response.ts            sendJson(), sendNoContent(), sendError()
│   │   └── context.ts             Build the per-request context; read route parameters
│   │
│   ├── middleware/
│   │   ├── compose.ts             Turns an array of middleware into one function (the onion)
│   │   ├── logger.ts              Per-request access log with status and duration
│   │   ├── errorHandler.ts        Catches everything and turns it into an HTTP response
│   │   ├── cors.ts                CORS headers, including preflight
│   │   └── defaultHeaders.ts      Cache-Control: no-store, X-Content-Type-Options: nosniff
│   │
│   ├── routes/
│   │   ├── health.routes.ts       GET /health
│   │   └── tasks.routes.ts        The six task endpoints
│   │
│   ├── data/
│   │   ├── task.store.ts          The in-memory store (the repository pattern)
│   │   └── seed.ts                The four sample tasks
│   │
│   └── validation/
│       └── task.validation.ts     Runtime validation of unknown request data
│
├── tests/
│   ├── helpers/testServer.ts      Starts the app on an OS-assigned port
│   ├── unit.test.ts               The store and the validators, tested directly
│   └── api.test.ts                End-to-end tests over real HTTP
│
├── docs/                          The long-form documentation (start here after the README)
├── .env.example                   Every configuration option, with explanations
├── .nvmrc                         Pins the Node version for nvm
├── tsconfig.json                  Type checking configuration (emits nothing)
└── tsconfig.build.json            Optional: emit JavaScript to dist/
```

### How a request flows

```
  client
    │  TCP connection
    ▼
  node:http  ── parses the raw bytes into req (IncomingMessage) and res (ServerResponse)
    │
    ▼
  app.ts listener ── builds the RequestContext (method, parsed URL, params)
    │
    ▼
  compose() pipeline ── the "onion", running in this order:
    │
    ├─▶ logger             start the clock
    │   ├─▶ errorHandler   try { ... }
    │   │   ├─▶ defaultHeaders
    │   │   │   ├─▶ cors          (answers OPTIONS preflight here and stops)
    │   │   │   │   ├─▶ router    match method + path -> params
    │   │   │   │   │   ├─▶ handler          read body, validate, call the store
    │   │   │   │   │   │   └─▶ sendJson / sendNoContent
    │   │   │   │   │   ◀─┘
    │   │   │   │   ◀─┘
    │   │   │   ◀─┘  errorHandler catches anything thrown above and writes the error response
    │   │   ◀─┘
    │   ◀─┘  logger records the real status code and the elapsed time
    ◀─┘
    │  response bytes
    ▼
  client
```

Notice that the **router is just the last middleware**. From the pipeline's point of view, routing is simply the final thing that runs — and it either responds or throws. That single idea is what makes the whole design fall out.

The order is not decoration. The logger sits *outside* the error handler so that when control returns to it, the error response has already been written and `res.statusCode` is accurate. Swap those two and every failed request would be logged as `200`.

→ Full walkthrough: [docs/04-code-walkthrough.md](docs/04-code-walkthrough.md) and [docs/05-routing-and-middleware.md](docs/05-routing-and-middleware.md)

---

## npm scripts

| Script | Command | What it does |
|---|---|---|
| `npm run dev` | `node --watch --env-file-if-exists=.env src/server.ts` | Runs the TypeScript directly and restarts on every save. |
| `npm start` | `node --env-file-if-exists=.env dist/server.js` | Runs the compiled JavaScript from `dist/`. Requires `npm run build` first. |
| `npm run build` | `tsc -p tsconfig.build.json` | Emits plain JavaScript to `dist/`. Refuses to emit if the types are unsound. |
| `npm run typecheck` | `tsc -p tsconfig.json` | **Checks** the types and writes nothing. |
| `npm test` | `node --test "tests/**/*.test.ts"` | Runs all 78 tests. |
| `npm run test:single-process` | `node --test --test-isolation=none "tests/**/*.test.ts"` | Same tests, all in one process. See below. |
| `npm run clean` | *(removes `dist/`)* | Deletes the build output. |

### Run `typecheck` as well as `dev`

This is worth internalising early, and it trips up nearly everyone:

> **Node runs TypeScript by *stripping* the types out. It does not *check* them.**

So `npm run dev` will happily run a file that has type errors — it deletes the annotations and executes the rest. Errors like passing a `number` where a `string` is expected are invisible at runtime and simply produce wrong behaviour.

TypeScript therefore has two completely separate jobs, and this project runs them separately on purpose:

| Job | Tool | Command |
|---|---|---|
| **Check** the types | `tsc` | `npm run typecheck` — fails, writes nothing |
| **Erase** the types | Node's stripper | `npm run dev` — just runs, checks nothing |

Run both. Or run the tests and `typecheck` together, which is exactly what CI should do.

> **`npm run test:single-process`** exists because `node --test` normally runs each test *file* in its own child process, which is better isolation. Some restricted or sandboxed environments block spawning child processes with piped output; this variant runs everything in one process instead. Use the normal `npm test` unless it fails for that reason.

---

## Configuration

All configuration comes from environment variables, read once at startup and validated. Copy `.env.example` to `.env` to override anything. Node reads that file itself (via `--env-file-if-exists`), so there is no `dotenv` dependency.

```bash
cp .env.example .env        # macOS / Linux
Copy-Item .env.example .env # Windows PowerShell
```

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | Label only. When it is not `production`, 500 responses include the underlying error message. |
| `HOST` | `127.0.0.1` | Interface to bind. `0.0.0.0` makes it reachable from other machines. |
| `PORT` | `3000` | `0` asks the OS for any free port. |
| `CORS_ORIGIN` | `*` | Value for `Access-Control-Allow-Origin`. |
| `MAX_BODY_BYTES` | `100000` | Largest accepted request body. Bigger bodies get a `413`. |
| `LOG_REQUESTS` | `true` | Set to `false` to silence the access log. |
| `SEED_DATA` | `true` | Set to `false` to start with an empty task list. |

Invalid values fail loudly at startup rather than silently falling back:

```
Error: Invalid environment variable PORT: expected a whole number between 0 and 65535, but received "three-thousand".
```

> On Windows PowerShell, `PORT=3001 npm run dev` does **not** work — that inline syntax is bash-only. Use `$env:PORT=3001; npm run dev`.

---

## Documentation

The code is commented throughout, but the concepts behind it need more room. Read these in order:

| | Chapter | What it covers |
|---|---|---|
| **01** | [HTTP and REST fundamentals](docs/01-http-and-rest-fundamentals.md) | What HTTP is on the wire; methods, status codes, headers; what REST really means; resources, URLs, idempotency, statelessness |
| **02** | [TypeScript for JavaScript developers](docs/02-typescript-for-javascript-developers.md) | Types from first principles; the two jobs of TypeScript; `unknown` versus `any`; generics; narrowing; and the full story of how Node runs `.ts` files |
| **03** | [The Node runtime and the http module](docs/03-node-runtime-and-the-http-module.md) | The event loop and the single thread; streams and buffers; `IncomingMessage`/`ServerResponse`; why there is no `req.body`; ESM; signals and graceful shutdown |
| **04** | [Code walkthrough](docs/04-code-walkthrough.md) | A file-by-file, top-to-bottom tour of this codebase, following one request from socket to response |
| **05** | [Routing and middleware](docs/05-routing-and-middleware.md) | How the router matches paths, and how the ~30-line `compose()` produces the middleware onion — with an Express comparison |
| **06** | [Errors and status codes](docs/06-errors-and-status-codes.md) | The `HttpError` hierarchy, the error envelope, every failure mode in one table, and decision trees for 400 vs 415 vs 422 and 200 vs 201 vs 204 |
| **07** | [Testing the API](docs/07-testing-the-api.md) | curl from scratch (including the Windows traps), a guided tour of every endpoint and failure, browser DevTools, GUI clients, and the automated test suite |
| **08** | [Next steps](docs/08-next-steps.md) | Persistence with `node:sqlite`, sorting and cursor pagination, authentication, rate limiting, frameworks, OpenAPI, Docker, CI |

If you only read one: **[01](docs/01-http-and-rest-fundamentals.md)** for the concepts, then **[04](docs/04-code-walkthrough.md)** to see them implemented.

---

## Why Node 24?

Node 24 can execute `.ts` files **directly**. It strips the type annotations and runs the remaining JavaScript, so there is no build step, no `ts-node`, no `tsx`, and no bundler between you and the code.

```bash
node --watch src/server.ts    # that is the entire development setup
```

Two consequences worth knowing up front:

1. **Only *erasable* TypeScript is allowed.** Syntax that would have to *generate* code — `enum`, `namespace` with runtime contents, constructor parameter properties like `constructor(private x: number)` — cannot simply be deleted, so Node refuses it. This project's `tsconfig.json` sets `erasableSyntaxOnly: true` so `tsc` rejects it at check time with a clear message, instead of you discovering it at runtime. See [chapter 02](docs/02-typescript-for-javascript-developers.md) for what to write instead.

2. **Types are not checked.** Covered above — run `npm run typecheck`.

You can still produce a conventional build with `npm run build`, which emits JavaScript to `dist/`. That is what you would ship to run on an older Node version or to avoid deploying the source.

---

## Testing

```bash
npm test
```

```
▶ TaskStore
  ✔ creates a task with a generated id and matching timestamps
  ✔ replaces every content field on PUT but preserves id and createdAt
▶ parseTaskWriteInput
  ✔ reports every problem at once instead of stopping at the first
▶ the tasks API over HTTP
  ✔ creates a task, returns 201, and points Location at the new resource
  ✔ returns 405 and an Allow header for a method the URL does not support
  ...
ℹ tests 78
ℹ pass 78
ℹ fail 0
```

Two layers:

- **`tests/unit.test.ts`** tests `TaskStore` and the validators directly — the only two modules with real logic in them.
- **`tests/api.test.ts`** is end-to-end. It starts a real server on an OS-assigned port and talks to it over a real socket with `fetch`. Nothing is mocked, so it verifies the contract a client actually experiences: status codes, headers, and the JSON shape.

Everything uses Node's built-in test runner (`node:test` + `node:assert/strict`), so there is no Jest, Mocha or `supertest` to install.

→ Complete guide, including how to write your own: [docs/07-testing-the-api.md](docs/07-testing-the-api.md)

---

## Troubleshooting

**`curl` prints a wall of HTML or behaves strangely**
In PowerShell, `curl` is an alias for `Invoke-WebRequest`. Use `curl.exe`:

```powershell
Get-Command curl     # reveals: Alias -> Invoke-WebRequest
curl.exe -i http://127.0.0.1:3000/health
```

**`Invoke-WebRequest : A parameter cannot be found that matches parameter name 'SkipHttpErrorCheck'`**
That flag is PowerShell 7+. Windows PowerShell 5.1 makes `Invoke-WebRequest` throw on any 4xx/5xx response instead. Use `curl.exe`, or wrap the call in `try`/`catch`.

**`EADDRINUSE` — port 3000 is already in use**
Something else has the port, usually a previous run. Find and stop it, or use another port:

```powershell
$env:PORT=3001; npm run dev
Get-NetTCPConnection -LocalPort 3000 | Select-Object OwningProcess
```

**`.env not found. Continuing without it.`**
Harmless. Node prints this when `--env-file-if-exists=.env` finds no `.env` file; the defaults are used. Copy `.env.example` to `.env` if you want to change anything.

**A type error did not stop the server**
Expected. Node strips types without checking them. Run `npm run typecheck`.

**`SyntaxError: TypeScript enum is not supported in strip-only mode`** (or a similar message about namespaces or parameter properties)
You used a TypeScript feature that cannot be erased. `npm run typecheck` catches this beforehand thanks to `erasableSyntaxOnly`. See [chapter 02](docs/02-typescript-for-javascript-developers.md) for the replacements.

**My tasks disappeared**
The store is in memory by design. Restarting the server reseeds the four sample tasks. Persistence is [chapter 08](docs/08-next-steps.md).

**`npm install` fails with `EPERM`**
In a restricted or sandboxed environment, npm's global cache directory may not be writable. Redirect it somewhere writable:

```powershell
npm install --cache "$env:TEMP\npm-cache"
```

**`node --test` fails with `spawn EPERM`**
Some sandboxed environments block spawning child processes with piped output, and `node --test` runs each test file in a child process. Use the single-process variant:

```bash
npm run test:single-process
```

---

## Design decisions, and the alternatives

Short version; each is argued at length in the relevant chapter.

| Decision | Why | The alternative |
|---|---|---|
| `node:http` instead of Express | Seeing routing, body parsing and middleware built by hand makes a framework legible instead of magical | Express, Fastify, Hono — see [chapter 08](docs/08-next-steps.md) |
| Node's native TypeScript | No build step, no `ts-node`, no bundler; `node --watch src/server.ts` is the whole setup | `tsx`, `ts-node`, or a build-first workflow |
| Zero runtime dependencies | Nothing between you and the code; supply-chain surface area of zero | Battle-tested packages for each concern |
| Hand-written validation | You cannot validate data with types that do not exist at runtime, so you may as well see the real thing once | Zod, Valibot, Ajv |
| In-memory `Map` store | No database to install or reset; you can experiment freely | SQLite (built into Node 24 via `node:sqlite`), Postgres |
| Errors via `throw`, one handler | Business logic never mentions HTTP; there is exactly one place that writes an error response | Handlers returning status codes, or per-route `try`/`catch` |
| JSON error envelope with a `code` | Clients branch on a stable `code` and read `message`; nobody has to parse prose | Bare string bodies, or RFC 9457 problem details |
| Offset pagination | Simple and obvious; adequate for small datasets | Cursor/keyset pagination, which does not degrade and does not skip rows |
| `node:test` instead of Jest | Zero dependencies, no configuration, no globals | Jest, Mocha, Vitest |

---

## Requirements

- **Node.js 24 or newer.** Check with `node --version`. If you use nvm, `nvm use` reads `.nvmrc`.
- A terminal. On Windows, **PowerShell 5.1 or 7** — note that `curl` is an alias in both, so use `curl.exe`.

## License

This is a learning project. Do whatever you like with it.
