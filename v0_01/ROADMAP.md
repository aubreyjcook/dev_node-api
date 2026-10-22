# Roadmap

This file records the plan for the **next** version. It exists so that each version not only documents where it has been, but also where it is going — and so a learner can watch a plan turn into a changelog, one version at a time.

The full reasoning behind every item below lives in [`docs/08-next-steps.md`](docs/08-next-steps.md); this file is the short, committed plan. Items are ordered by the value they add relative to their risk.

---

## Planned for v0.02

### 1. Persistence — the headline change

**What:** replace the in-memory `Map` with a durable store backed by `node:sqlite` (built into Node 24 — no new runtime dependency).

**Why:** today every restart wipes the data, and two server processes would disagree about what exists. Durable data is the prerequisite for everything else.

**Where:** a new `src/data/sqlite-task.store.ts` exposing the same methods as `TaskStore`, plus one changed line in `src/app.ts` to construct it. The repository pattern means **no route handler changes** — this is the payoff of the store returning `undefined` instead of throwing.

**Watch out for:** on Node 24 the exported class is `DatabaseSync` (the `Database` name arrived in a later release line), and SQLite reads booleans back as `0`/`1`.

### 2. Sorting and cursor pagination

**What:** add a `?sort=` parameter (with an allow-list of fields — never interpolate a client string into SQL) and move from `offset` pagination to keyset/cursor pagination.

**Why:** offset pagination scans and skips rows on large, changing tables. Sorting is the difference between a list in arbitrary order and one a user can actually use.

**Where:** `parseTaskListQuery` in `src/validation/task.validation.ts`, the store's `list()`, and the `GET /api/tasks` handler.

### 3. Request IDs and structured logging

**What:** assign every request a `crypto.randomUUID()` id, return it in an `X-Request-Id` header, and log each request as a single structured line including that id.

**Why:** a generic 500 message plus a log file means you cannot connect a client's report to a server line. Request IDs close that loop.

**Where:** a small middleware in `src/middleware/`, the `logger.ts` output, and the error handler.

### 4. Configuration validation

**What:** validate `process.env` with a schema library instead of the hand-written readers in `src/config.ts`.

**Why:** the project already demonstrates hand-written validation of request bodies; the same discipline applied to configuration is the natural next application, and a schema library (e.g. Zod) is the tool that will also clean up request validation.

### 5. Authentication (stretch — may slip to v0.03)

**What:** an `authenticate` middleware using API keys or bearer tokens, with `node:crypto` for password hashing.

**Why:** every real API needs it, and it is the first thing that requires careful thought about middleware *position* (inside CORS, outside the router).

**Risk:** large surface area. If v0.02 is meant to stay a single self-contained step, defer this to v0.03.

---

## Deferred (see `docs/08` for the full list)

OpenAPI documentation, caching/ETags, rate limiting, a real framework comparison, Docker, and CI. These are valuable but build on top of the items above rather than enabling them.
