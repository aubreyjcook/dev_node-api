# Changelog

This file records what changed in **this version** relative to the one before it. It exists for the learner: rather than diffing directories blindly, read the change list, then open the code and the referenced documentation to see the change implemented.

Each entry follows the same shape: **what** changed, **why**, and **where to look** in this version to see it.

---

## v0.01 — Initial release

The first alpha snapshot. There is no previous version, so "what changed" is everything: this version establishes the whole project.

### What this version introduces

| Area | What was built | Where to look |
|---|---|---|
| **The API** | A complete CRUD resource (`/api/tasks`) plus a health check (`/health`), served over HTTP/1.1 | `src/routes/tasks.routes.ts`, `src/routes/health.routes.ts` |
| **No framework** | The server is built directly on `node:http`, so routing, body parsing, CORS and error handling are all visible | `src/server.ts`, `src/app.ts` |
| **A router** | Hand-written method + `:param` path matching, with correct `404`/`405` handling | `src/router.ts` |
| **A middleware pipeline** | The Koa-style "onion" model in ~30 lines | `src/middleware/compose.ts` |
| **Runtime validation** | Request bodies and query strings are validated by hand against `unknown` | `src/validation/task.validation.ts` |
| **An error vocabulary** | One `HttpError` hierarchy and a single middleware that turns throws into responses | `src/http/errors.ts`, `src/middleware/errorHandler.ts` |
| **An in-memory store** | A `Map`-backed repository, deliberately swappable | `src/data/task.store.ts` |
| **Native TypeScript** | Node 24 runs the `.ts` files directly (type stripping), so there is no build step | `tsconfig.json`, `package.json` |
| **Zero runtime dependencies** | Only `typescript` and `@types/node` as development tools | `package.json` |
| **Tests** | 78 unit + end-to-end tests using Node's built-in runner | `tests/` |
| **Documentation** | Eight learning chapters, from HTTP fundamentals to next steps | `docs/` |

### Design decisions worth noting for the learner

These are the choices that shape everything downstream, and the reasoning is spread across the docs:

- **`node:http` instead of Express** — so routing, parsing and middleware are legible rather than magical ([`docs/03`](docs/03-node-runtime-and-the-http-module.md), [`docs/05`](docs/05-routing-and-middleware.md)).
- **Errors are thrown, not returned** — one middleware converts them to responses, so business logic never mentions HTTP ([`docs/06`](docs/06-errors-and-status-codes.md)).
- **The store returns `undefined`, never throws `404`** — the data layer knows nothing about HTTP, which is what will make swapping in a database cheap ([`docs/04`](docs/04-code-walkthrough.md)).
- **Types are erased, not checked, at runtime** — which is why validation is done by hand ([`docs/02`](docs/02-typescript-for-javascript-developers.md)).

### What this version deliberately omits

No persistence (data is lost on restart), no authentication, no sorting, no structured logging, and no API versioning. Each is a candidate for a future version — see [`ROADMAP.md`](ROADMAP.md).
