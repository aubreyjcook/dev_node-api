# Next Steps

You have read the whole API: about a thousand lines of TypeScript, zero runtime dependencies, six endpoints. What follows is what to learn or build next, ordered by how obvious the gap is rather than by how interesting the topic is.
The project is deliberately incomplete in ways a tutorial usually hides. There is no persistence, so a restart erases everything. There is no authentication, so every client sees every task. There is no structured logging, so a production incident would be invisible. Those are the design of a teaching project, and each one is a chance to meet a real problem from the inside.
Every item says what it is, why you would want it, how much work it is (small / medium / large), and gives a starting point you can paste, run, or read. Where a decision has real trade-offs, both sides are stated rather than a winner declared. The natural first steps are all in Tier 1.

---

## Tier 1: the obvious next steps

### 1. Persistence (the single biggest gap)

**Effort: small for SQLite, medium for JSON files, large for a networked database.**
`src/data/task.store.ts` keeps tasks in a `Map`, and its own header comment states the consequences: everything is lost when the process exits, and two running instances disagree about what exists. Because the store is the only module that touches data, swapping it requires no changes to any route handler. That is the repository pattern, and this is the project where you see its payoff instead of reading about it.

#### 1a. `node:sqlite` -- the headline recommendation

A SQLite driver ships with Node, so this keeps the zero-dependency property intact. The module is [`node:sqlite`](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) (the v24 page specifically -- see the naming note below); it stopped being behind `--experimental-sqlite` in Node 22.13/23.4 and works unflagged on Node 24, though it is still marked a release candidate there, so expect occasional API adjustment. Note that this project requires Node 24, and **the class names differ between release lines**, which is a trap worth being explicit about.

On Node 24 the exported classes are `DatabaseSync` and `StatementSync`. The rename to `Database` (with `DatabaseSync` kept as a deprecated alias) happened in a later line, and the Node docs site at `nodejs.org/api/sqlite.html` shows the *newest* release by default, not the version you are running. Code written against `Database` therefore throws `TypeError: Database is not a constructor` on Node 24. Always probe the runtime before trusting an article or a doc page:

```bash
node --version
node -e "const m = require('node:sqlite'); console.log(Object.keys(m).join(', '))"
# v24.22.0
# DatabaseSync, StatementSync, Session, constants, backup
```

`DatabaseSync` says "sync" for a reason: every one of its APIs executes synchronously.

A schema for the model this project already has. `STRICT` makes SQLite reject a wrongly typed value instead of coercing it -- TypeScript discipline applied to the database.
```sql
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT    NOT NULL,
  description TEXT,
  priority    TEXT    NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
  completed   INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
) STRICT;
-- The index that makes the keyset pagination in item 2 cheap.
CREATE INDEX IF NOT EXISTS idx_tasks_created_at_id ON tasks (created_at, id);
```

A store satisfying the same interface. Sketch, not a finished implementation.

```ts
// src/data/sqlite-task.store.ts  (sketch)
// DatabaseSync on Node 24; on a later line this class is also exported as `Database`.
import { DatabaseSync } from 'node:sqlite';
import type { Task } from '../types/task.ts';
/** SQLite has no boolean type: it stores 0/1 and returns numbers. */
interface TaskRow {
  readonly id: string; readonly title: string; readonly description: string | null;
  readonly priority: string; readonly completed: number;
  readonly created_at: string; readonly updated_at: string;
}
/** The one place that maps between a row and a domain object. */
function toTask(row: TaskRow): Task {
  return {
    id: row.id, title: row.title, description: row.description,
    priority: row.priority as Task['priority'],
    completed: row.completed === 1, // number -> boolean, at the boundary
    createdAt: row.created_at,      // snake_case in SQL, camelCase in JSON
    updatedAt: row.updated_at,
  };
}
export class SqliteTaskStore {
  readonly #db: DatabaseSync;
  constructor(filename = 'tasks.db') {
    this.#db = new DatabaseSync(filename, { timeout: 5_000 });
    // WAL lets readers proceed during a write; without it one writer blocks all readers.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(SCHEMA_SQL); // the CREATE TABLE / CREATE INDEX block above
  }
  findById(id: string): Task | undefined {
    // A bound parameter. Never build SQL by pasting values into a string.
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row === undefined ? undefined : toTask(row);
  }
  delete(id: string): boolean {
    return this.#db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
  }
  // ...create, replace, update, list, count, seed, clear follow the same shape.
}
```

Two details matter, and they are exactly what the in-memory store was teaching: `findById` returns `Task | undefined` rather than throwing, and `delete` reports a boolean. Those two choices are what make the swap cheap, because the handler's `undefined` and `!removed` branches already exist.

**Swapping it without touching handlers, in three steps.**
1. **Extract an interface.** `tasks.routes.ts` currently imports `TaskStore` as a type. Make that an interface the in-memory class implements, and let the route module depend on the interface.
2. **Decide whether store methods stay synchronous.** `node:sqlite` is synchronous, so you *can* keep them sync and change nothing else. But the moment you move to Postgres every method returns a promise and every handler needs an `await`. Recommendation: make the interface promise-returning now and accept one `await` per handler, in exchange for a much cheaper migration later. Keeping it sync is honestly defensible for SQLite only, as long as you remember the conversion is still ahead of you.
3. **Inject it.** `buildApp` already builds the store and passes it through `TaskRouteDependencies`, so this is one changed line driven by config: `const store: TaskStore = config.databaseUrl === ':memory:' ? new TaskStore() : new SqliteTaskStore(config.databaseUrl);`
One real caveat about synchronous SQLite: every query blocks the event loop, so a slow query stalls *every* concurrent request, not just the one that caused it. For indexed lookups on a small dataset that is microseconds and a non-issue. It stops being a non-issue at the point where you are scanning large tables, which is precisely item 2.

#### 1b. The JSON-file alternative

Simplest durability available: serialise the map to a file on every write with `node:fs` and no dependency. The naive version is `writeFileSync('tasks.json', JSON.stringify([...this.#tasks.values()]))`, and it fails in two instructive ways.

- **Concurrency.** Two overlapping writes clobber each other. In-process a `Map` write is atomic because Node's single thread cannot be interrupted mid-statement; a file write *is* interruptible, because it awaits I/O.
- **Crash safety.** `writeFileSync` truncates first, then writes. A crash or full disk in between leaves a truncated, unparseable file and no data. Small window, total loss.

**Atomic writes fix the second problem** and are worth knowing regardless: write to a temp file in the same directory, `fsync` it, then `rename` over the target. `rename` is atomic on POSIX and within a volume on Windows, so a reader sees either the complete old file or the complete new one.
```ts
// src/data/atomic-write.ts (sketch)
import { open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  // Same directory as the target: rename is only atomic within one filesystem.
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temp, 'w');
  try {
    await handle.writeFile(contents, 'utf8');
    // Force bytes to disk before the rename, or a power loss can leave the
    // renamed file present but empty.
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}
```

Even with atomic writes you still have the multi-process problem: two servers writing one file lose each other's changes, because there is no locking and no coordination. That is where you want a database, not a better file writer.

#### 1c. Postgres or MySQL

**Effort: large**, and mostly not because of the queries. A networked database buys real transactions, concurrent writers, a query planner and a process you can back up. It costs a set of concerns SQLite and a file let you ignore.

- **Driver and pool.** `pg` for Postgres, `mysql2` for MySQL/MariaDB. A pool keeps N connections open and hands one out per query; opening a connection per request is slow, and a single shared connection serialises everything. `npm install pg && npm install --save-dev @types/pg`, then `new Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000 })`. Keep `max` well under the server's own connection limit.
- **Migrations.** Every schema change must reach every environment in the same order. Hand-rolled migrations are a directory of numbered `.sql` files plus a `schema_migrations` table recording which have run; `node-pg-migrate`, `dbmate` or `knex` do the bookkeeping. The discipline that matters is that migrations are append-only and committed alongside the code that needs them.
- **Placeholders differ**, which is a common source of copy-paste bugs. Postgres uses `$1`; MySQL and `node:sqlite` use `?`; `node:sqlite` also supports named `:name` parameters. Bind, never interpolate: `await pool.query('SELECT * FROM tasks WHERE id = $1', [id])`.
- **Docker for development**, so no local install is needed: `docker run --name tasks-db -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=tasks -p 5432:5432 -d postgres:17-alpine`.
- **Upsert** replaces the "check, then insert or update" pair.
```sql
INSERT INTO tasks (id, title, description, priority, completed, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, updated_at = EXCLUDED.updated_at
RETURNING *;
```

MySQL spells it `ON DUPLICATE KEY UPDATE`; SQLite's `INSERT ... ON CONFLICT ... DO UPDATE` has the same shape as the Postgres version.

**Trade-off summary.** SQLite gives durability, transactions and real queries at almost no operational cost, and stops being sufficient when you need many concurrent writers or more than one machine. Postgres is the right answer the moment either is true, and it is more work than most people expect. A JSON file is the wrong production answer and a perfectly good way to understand why atomic writes exist.

### 2. Sorting and cursor pagination

**Effort: small.**
`GET /api/tasks` supports `?limit=` and `?offset=`, and offset pagination has two problems that only appear with real data. **Cost:** `OFFSET 100000` does not skip to row 100000; the database still walks and discards those rows, so page 5000 costs 5000 pages of work. That is what `OFFSET` means, not a SQLite quirk. **Correctness:** offset addresses a position, not a row, so if a task is inserted or deleted while a client pages through, every later page shifts by one and the client either sees a row twice or never sees it. For infinite scroll over a changing table that is a visible bug.

**Cursor (keyset) pagination** fixes both by remembering where you stopped rather than how far you have come.
```sql
-- "The next page starts after the row I last saw."
-- $1 is the last created_at, $2 the last id (the tiebreaker), $3 the limit.
SELECT * FROM tasks
WHERE completed = 0 AND (created_at, id) > ($1, $2)
ORDER BY created_at, id
LIMIT $3;
```

The cursor is an opaque string the client echoes back. Base64 a small object and treat the encoding as private so you can change it later; decode it as untrusted input and reject malformed values with a 400.
```ts
// src/http/cursor.ts (sketch)
const encodeCursor = (c: { createdAt: string; id: string }) =>
  Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
function decodeCursor(raw: string): { createdAt: string; id: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    // A cursor is untrusted input: it came from a client.
    const ok = typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as { createdAt: unknown }).createdAt === 'string' &&
      typeof (parsed as { id: unknown }).id === 'string';
    return ok ? (parsed as { createdAt: string; id: string }) : undefined;
  } catch { return undefined; }
}
```

The response then carries a `nextCursor` instead of a `total`, because counting the entire matching set on every page is itself a full scan.

**Sorting needs an allow-list, and this is the security-relevant part.** You cannot bind an identifier as a parameter: `ORDER BY ?` binds a *value*, and SQL has no way to parameterise a column name. So the column name must be interpolated, which means it must never come from the client verbatim.
```ts
// Never this. SQL injection with extra steps.
const sql = `SELECT * FROM tasks ORDER BY ${req.query.sort}`;
// This instead: a closed map from a public name to a SQL fragment you wrote.
const SORTS = { createdAt: 'created_at', updatedAt: 'updated_at',
                title: 'title', priority: 'priority' } as const;
type SortField = keyof typeof SORTS;
const isSortField = (v: string): v is SortField => Object.hasOwn(SORTS, v);
const column = SORTS[field];                         // always a literal we wrote
const direction = order === 'desc' ? 'DESC' : 'ASC'; // never a raw client string
const sql2 = `SELECT * FROM tasks ORDER BY ${column} ${direction}, id ASC`;
```

`isSortField` is the same "is it one of these exact strings" pattern as `isTaskPriority` in `src/validation/task.validation.ts`. Add `sort` and `order` to `LIST_QUERY_FIELDS` so they are validated with the other query parameters, and reject anything outside the map with a 400 rather than silently defaulting -- the same reasoning that file already gives for rejecting `?completd=true`. Default the sort to whichever field your cursor uses, and always end the ordering with `id`: without a unique tiebreaker, rows with equal sort values have no defined order between pages and cursor pagination silently duplicates them.

### 3. Structured logging

**Effort: small.**
`src/middleware/logger.ts` writes a colored line with `console.log`. It is pleasant while developing and close to useless in production, for one reason: a log line is a string, so you cannot ask it questions. "Every request slower than 500ms from user 42" is easy against structured data and a parsing project against text.
[`pino`](https://getpino.io/) is the usual Node choice: newline-delimited JSON, fast enough to leave on in production.
```ts
// src/logger.ts (sketch)
import { pino } from 'pino';
import { config } from './config.ts';
export const logger = pino({
  level: config.logLevel, // trace | debug | info | warn | error | fatal
  // Pretty output is for humans at a terminal: slower and much harder to parse, so
  // development-only. `pino-pretty` is a separate install, which is why production
  // can be missing it without failing.
  transport: config.nodeEnv === 'development'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});
```

The middleware then logs an object rather than a sentence, and the levels carry meaning: `info` for completed requests, `warn` for 4xx, `error` for 5xx. Logging everything at `info` means the level setting buys you nothing.

**Request IDs** are the part people skip and then need most. When a user reports "I got an error at 2:15", you must find *that* request among thousands of interleaved ones. Generate an ID per request, include it in every log line for that request, and return it in a response header so it can be quoted. Honour an inbound `X-Request-Id` so a request can be traced across services -- but validate it, because it is attacker-controlled text that ends up in your logs and headers.
```ts
// src/middleware/requestId.ts (sketch)
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/; // hex and dashes, length-capped
export function createRequestId(): Middleware {
  return async (ctx, next) => {
    const inbound = ctx.req.headers['x-request-id'];
    const id = typeof inbound === 'string' && VALID_REQUEST_ID.test(inbound)
      ? inbound : randomUUID();
    ctx.requestId = id;                    // add to RequestContext
    ctx.res.setHeader('X-Request-Id', id); // hand it back to the client
    await next();
  };
}
```

Where does it go? Near the front, before the logger, so the logger can include it. The order in `src/app.ts` becomes `requestId -> logger -> errorHandler -> defaultHeaders -> cors -> router`. Apply the question the header comment in `app.ts` already asks about every middleware: what has to be true *outside* me?
One subtlety: the logger sits outside everything, so it can log the ID directly, but a function five calls deep with no `ctx` cannot. Thread the logger through explicitly (tedious but obvious) or carry it in [`AsyncLocalStorage`](https://nodejs.org/api/async_context.html) (implicit, contained to one module). For a project this size, start explicit.

### 4. Configuration validation with a schema library

**Effort: small.**
`src/config.ts` already does this correctly: `readString`, `readInteger` and `readBoolean` validate `process.env`, fail loudly at startup, and produce a typed `AppConfig`. The cost is a bespoke reader per type and a hand-maintained interface. The same idea with a schema library is shorter and gives you one validation idiom for environment variables *and* request bodies.
```ts
// src/config.ts (sketch, Zod)
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000), // coerce: env vars are strings
  CORS_ORIGIN: z.string().default('*'),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(100_000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z.string().default(':memory:'),
});
const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Print every problem and exit. A process that starts with bad configuration is
  // worse than one that refuses, because the failure surfaces later and elsewhere.
  console.error('Invalid configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}
export const config = parsed.data; // fully typed; the hand-written interface disappears
```

The payoff is that last line: the schema *is* the type, so `AppConfig` goes away. That argument applies just as well to request bodies (item 5). One caveat: `z.coerce.number()` turns `''` into `0` and `PORT=abc` into a validation error you now have to read carefully, whereas the existing `readInteger` is more careful about empty strings. Check the coercion behavior before trusting it.

---

## Tier 2: robustness and production concerns

### 5. Validation libraries

**Effort: small to medium, mostly retraining your reflexes.**
`src/validation/task.validation.ts` is 544 lines that validate four fields and four query parameters. It is excellent code and worth reading once carefully, because it teaches you what a validator does. You probably should not write another one.

| Library | Shape | Strengths | Watch out for |
| --- | --- | --- | --- |
| [`zod`](https://zod.dev/) | Fluent, TypeScript-first | Huge adoption, excellent inference, JSON Schema generation built in | Historically heavy; v4 cut size substantially |
| [`valibot`](https://valibot.dev/) | Small composable functions | Tiny bundle via tree-shaking | Less ubiquitous, so fewer examples and integrations |
| [`ajv`](https://ajv.js.org/) | JSON Schema documents | The schema *is* the artifact: shareable, storable, reusable for serialization | Schemas are data, not TypeScript, so inference is a step further away |

The current title and description rules, expressed once:
```ts
// src/validation/task.schema.ts (sketch, Zod)
export const TaskWriteSchema = z.object({
  title: z.string().trim().min(1, 'Must not be empty or whitespace only.').max(200),
  // Mirrors readDescription()'s three-way behavior: absent or empty -> null.
  description: z.string().trim().max(2000).nullish()
    .transform((v) => (v === undefined || v === null || v === '' ? null : v)),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  completed: z.boolean().default(false),
})
  // Zod strips unknown keys by default; this project deliberately rejects them
  // instead, so the strictness has to be stated explicitly.
  .strict();
export type TaskWriteInput = z.infer<typeof TaskWriteSchema>;
```

`safeParse` returns a result object instead of throwing, so the `422` convention only survives if you deliberately restore it -- and mapping the library's issues onto this project's `{ field, message }` envelope is your code, not the library's:
```ts
const parsed = TaskWriteSchema.safeParse(await readJsonBody(ctx.req, maxBodyBytes));
if (!parsed.success) {
  throw new UnprocessableEntityError('The request body failed validation.',
    parsed.error.issues.map((i) => ({ field: i.path.join('.') || '(body)', message: i.message })));
}
const task = store.create(parsed.data);
```

**What you gain:** much less code, composable schemas (`TaskWriteSchema.partial()` plus an "at least one key" refinement gives you the PATCH validator), automatic types via `z.infer`, and JSON Schema generation for the OpenAPI document in item 12. **What you lose:** a dependency in a project whose identity is zero dependencies; a second API to learn on top of TypeScript; error messages in someone else's wording that you must translate; and a little control over when validation runs. The hand-written validator's advantage is that you can read it top to bottom and know exactly what it does. That is not nothing.

### 6. Authentication and authorization

**Effort: medium to authenticate, large to get authorization right.**
Today anyone who can reach the port can read and modify every task. Keep the two words separate throughout: **authentication** is "who are you", **authorization** is "may you do this". The second is where the real bugs live, and [OWASP's API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) puts broken object-level authorization at number one.

| Approach | State | Best for | The honest downside |
| --- | --- | --- | --- |
| API keys | Stateless | Server-to-server, scripts, internal services | Long-lived, hard to rotate, coarse scope, leaks are quiet |
| Session cookies | Server-side session store | Browser apps | Needs a store, CSRF protection, and correct cookie flags |
| JWTs | Stateless, self-contained | Distributed systems, multiple services, mobile | Revocation is genuinely hard; every "just decode it" mistake is a hole |

**API keys** are a random string stored hashed (never plaintext -- treat a key exactly like a password) and looked up per request: simple, and a good first implementation, though they tend to live forever in a config file and cannot express "this token may only read tasks".

**Session cookies** are the safest choice for a browser app: the server stores session state and gives the client an opaque ID in a cookie. Setting `Access-Control-Allow-Credentials: true` means the CORS origin can no longer be `*` (item 8), and you need CSRF protection, because browsers send cookies automatically on cross-site-initiated requests; `SameSite=Lax` or `Strict` plus a CSRF token covers it.

**JWTs** carry signed claims, so any service can verify them without a lookup. That is the appeal and the trap: a signed token is valid until it expires, and "until it expires" is not a mistake you can fix retroactively. Revocation needs a denylist, or short-lived tokens plus refresh tokens, at which point you have reintroduced the state you were avoiding. Never trust the payload without verifying the signature, and never let the client choose the algorithm (`alg: none`, HS256/RS256 confusion); pin what you accept:
```ts
const payload = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
// Not jwt.decode(token): that parses without verifying. Base64 is not a signature.
```

#### Storing passwords correctly

If you store passwords at all, this is the part that must be right. Node ships what you need.
```ts
// src/auth/password.ts (sketch)
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer, salt: string | Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
// Cost parameters, not magic numbers: N is CPU/memory cost, r block size, p parallelism.
// Raise N as hardware gets faster.
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(password: string): Promise<string> {
  // A fresh random salt per user. Two users with the same password must not produce
  // the same hash, or one cracked hash reveals both and precomputation helps again.
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64, PARAMS);
  // Store the parameters with the hash: you will want to raise them later, and you
  // cannot verify an old hash without knowing how it was made.
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || n === undefined || hashB64 === undefined) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64!, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  // timingSafeEqual requires equal lengths and throws otherwise, so check first.
  if (actual.length !== expected.length) return false;
  // Constant time: it compares every byte regardless of where the first difference is,
  // so duration does not leak how much of the hash matched.
  return timingSafeEqual(actual, expected);
}
```

**Why the comparison must not short-circuit.** A loop with an early `return false` runs measurably faster for a value matching the first byte than for one matching none, so an attacker who can time the response can recover a secret byte by byte. Over a network this is noisy for a full hash comparison, but the discipline costs nothing and the same function guards things where it matters enormously. It is also why you never compare tokens with `===`.

**Why `sha256` alone is wrong.** A general-purpose hash is designed to be *fast*; a GPU computes billions of SHA-256 hashes per second, so a leaked table falls quickly even with salts. `scrypt` is deliberately slow and **memory-hard** -- it needs a lot of RAM per guess, which limits parallelisation on the hardware attackers actually use. `bcrypt` and `argon2` exist for the same reason, and `argon2id` is the current recommendation when choosing fresh; they are dependencies, which is why `node:crypto`'s `scrypt` is the natural fit here. Never store plaintext, never store a fast hash alone, and never invent a scheme by hashing in a home-made loop.

#### An `authenticate` middleware

It fits the pipeline shape exactly: read the header, verify, attach the identity or throw.
```ts
// src/middleware/authenticate.ts (sketch)
export function createAuthenticate(lookup: (token: string) => Promise<User | undefined>): Middleware {
  return async (ctx, next) => {
    const header = ctx.req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('A bearer token is required.'); // add this 401 class
    }
    const user = await lookup(header.slice('Bearer '.length).trim());
    if (user === undefined) {
      // The same message for "no such token" and "bad token": distinguishing them
      // tells an attacker which half they got right.
      throw new UnauthorizedError('The provided token is not valid.');
    }
    ctx.user = user; // add `user?: AuthenticatedUser` to RequestContext
    await next();
  };
}
```

**Where in the order?** After CORS, before the router: `requestId -> logger -> errorHandler -> defaultHeaders -> cors -> authenticate -> router`. Three reasons. **Before the router**, so no handler can forget it -- authentication outside routing is a policy, not a habit. **After CORS**, because a browser needs CORS headers on a 401 in order to read it at all, and the CORS middleware must be outside whatever throws in order to set headers on the error path too; move `authenticate` outside `cors` and a clear 401 becomes an opaque network failure in the console. **Before the body is read**, because rejecting on a header means an unauthenticated 10 MB body is never buffered -- which matters for item 8. Exempt `/health` and the login/register endpoints, preferably with an explicit allow-list rather than a deny-list.

#### Scoping resources to an owner

Adding an `owner_id` column is easy. The bug that follows is subtle and extremely common: the handler verifies the *requester* but not the *resource*.
```ts
// The bug: any authenticated user reads any task by guessing an id.
const task = store.findById(id);
if (task === undefined) throw new NotFoundError(...);
sendJson(ctx.res, 200, task);
// Option A, better: make the owner part of the lookup, so there is no method that
// can return someone else's task.
const task2 = store.findByIdForOwner(id, ctx.user.id);
// Option B: check in the handler.
if (task === undefined || task.ownerId !== ctx.user.id) {
  throw new NotFoundError(`No task exists with id "${id}".`); // 404, not 403
}
```

**Why 404 rather than 403 for another user's resource.** A 403 says "this exists and you may not have it", confirming the existence of a resource the requester has no business knowing about. If ids were sequential, a 403/404 distinction would let someone enumerate the whole table by watching which ids return 403. A 404 makes "does not exist" and "not yours" byte-identical, which is the property you want. The cost is a less informative error for a legitimate user who genuinely lacks permission -- a real trade-off, and 404 is still usually the right side of it. `src/http/errors.ts` already makes this argument for route-level 404s; this is the same reasoning applied to ownership.
Finally, authorization is per-*operation*, not per-route: a user who may read their own task may not be allowed to delete it or set `priority: 'high'`. Write the rules down as a table before writing the checks, because scattered `if (ctx.user.role === ...)` conditions are how authorization becomes unauditable.

### 7. Rate limiting

**Effort: small for one process, medium once there is more than one.**
Three reasons, only the first of which is an attack. **Credential stuffing**: without a limit an attacker gets unlimited password guesses, so login should be limited more strictly than everything else. **Scraping**: pulling your dataset one page at a time costs bandwidth and money. **Accidental loops**: a retry bug or a `useEffect` with a missing dependency can generate thousands of requests per second from a friendly user, which happens far more often than the first two.
```ts
// src/middleware/rateLimit.ts (sketch)
export function createFixedWindowRateLimit(options: { limit: number; windowMs: number }): Middleware {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return async (ctx, next) => {
    // Identify the client. `socket.remoteAddress` is the direct peer, which behind a
    // proxy or load balancer is the proxy, not the user. There you must read
    // X-Forwarded-For -- and only trust it when you know a proxy you control sets it.
    const key = ctx.req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let w = windows.get(key);
    if (w === undefined || now >= w.resetAt) {
      w = { count: 0, resetAt: now + options.windowMs };
      windows.set(key, w);
    }
    w.count += 1;
    const remaining = Math.max(0, options.limit - w.count);
    // The IETF rate-limit header fields. The older X-RateLimit-* variants are still
    // common; pick one set and stay consistent.
    ctx.res.setHeader('RateLimit-Limit', String(options.limit));
    ctx.res.setHeader('RateLimit-Remaining', String(remaining));
    ctx.res.setHeader('RateLimit-Reset', String(Math.ceil((w.resetAt - now) / 1000)));
    if (w.count > options.limit) {
      // Retry-After turns "back off somehow" into "back off for 12 seconds".
      ctx.res.setHeader('Retry-After', String(Math.ceil((w.resetAt - now) / 1000)));
      throw new TooManyRequestsError('Rate limit exceeded. Try again shortly.'); // add a 429 class
    }
    await next();
  };
}
```

Place it early -- before `authenticate` -- so brute-force attempts are throttled before you do the expensive work of hashing a password to check it. The counter key is then the IP, since you do not yet know who the caller is.

**The honest limitation: this does not work across processes.** The `Map` lives in one process's memory, so four instances behind a load balancer each keep their own counter and the effective limit is four times what you configured. Multi-process limiting needs shared state: Redis with a counter and an expiry, or a token bucket as a Lua script so the read-modify-write is atomic. This is one of the few places where adding Redis is genuinely the answer rather than premature infrastructure.
Two refinements worth knowing: a **token bucket** permits a burst up to a bucket size while enforcing a sustained average, which is friendlier than a window that resets like a cliff edge; **sliding windows** avoid the fixed-window artifact where a client sends twice the limit across a boundary. Neither is necessary to start.

### 8. Security hardening

**Effort: small for headers and timeouts, medium for TLS.**
**TLS termination** happens at a reverse proxy or load balancer (nginx, Caddy, an ALB, Cloudflare) in practice, because that is where certificate management already lives; the API then speaks plain HTTP on a private network. If you do terminate TLS in Node, use [`node:https`](https://nodejs.org/api/https.html) and `createSecureServer`; HTTP/2 is a separate story again.

**`Strict-Transport-Security` (HSTS)** tells a browser to refuse plain HTTP to this host for the given duration, closing the downgrade window:
```
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Only set it when every subdomain is served over HTTPS, and be careful with the duration: browsers cache it aggressively and you cannot easily un-tell a browser that already saw a two-year `max-age`. It is ignored over plain HTTP by definition, so it belongs at the TLS-terminating layer.

**Stop using `*` for CORS in production.** `CORS_ORIGIN` defaults to `'*'`, which in a browser context means any website can call this API using a logged-in visitor's credentials. As `src/middleware/cors.ts` explains, CORS is enforced by the browser, so `*` is irrelevant to `curl` -- but it is very relevant to that malicious page. Set an explicit origin allow-list, echo back only allowed origins, and keep the `Vary: Origin` header the middleware already sets.

**Helmet-style headers.** [`helmet`](https://helmetjs.github.io/) sets a batch; for a JSON API the ones that matter are `X-Content-Type-Options: nosniff` (already set in `defaultHeaders.ts`), `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY` or a `frame-ancestors` CSP. The CSP and frame options are irrelevant to pure JSON and relevant the moment you serve HTML from the same origin, where they are defence-in-depth against the reflected-content risk `src/routes/tasks.routes.ts` already warns about.

**Request timeouts.** Node's defaults are generous, and a slow-loris client that opens a connection and dribbles headers can hold it open. Set all three explicitly:
```ts
// src/server.ts (sketch)
server.headersTimeout = 10_000;   // time allowed to finish sending headers
server.requestTimeout = 30_000;   // time allowed for the whole request
server.keepAliveTimeout = 5_000;  // idle time before an unused keep-alive socket closes
```

One ordering note: `keepAliveTimeout` should be shorter than the idle timeout of whatever proxy sits in front, or the proxy reuses a connection your server has just closed and you get intermittent `502`s that are miserable to debug.

**`MAX_BODY_BYTES` is a denial-of-service control, not a nicety.** Without a limit, one request with a 10 GB body buffers the whole thing and the process dies; the implementation checks the announced `Content-Length` *and* counts bytes as they stream, because a client can omit or lie about the length, so keep both checks.

**Deeply nested JSON** is the other body-parser attack: a kilobyte of `{"a":{"a":{"a":...}}}` can produce a nested object that blows the stack when walked recursively, and `JSON.parse` limits are higher than you might expect. Reading one level of known fields makes the hand-written validator naturally immune -- an accidental but real advantage of not using a generic deep-merging parser. If you adopt a validation library (item 5), check that deeply nested input fails gracefully; bounding depth in the validator is the fix, not `--stack-size`.

### 9. Testing depth

**Effort: small for coverage, medium for a real-database suite.**
The current setup is good: `node:test` with `node:assert/strict`, real `fetch`, a server on port 0, no mocking framework. Two things are missing: coverage visibility and any test that touches a database.
Coverage is built into the runner: `node --test --experimental-test-coverage "tests/**/*.test.ts"`. Treat the number as a pointer, not a target: 100% coverage with no assertions is common and worthless. The useful habit is to look at what is uncovered and ask whether you *meant* not to test it.

**`supertest`** wraps an app in a fluent request API -- `await request(app.listener).post('/api/tasks').send({ title: 'x' }).expect(201)` -- with no port and no server lifecycle to manage. Honest assessment: **for this project, keep the raw `fetch`.** Because the app is built as a listener and the test helper already handles port 0 and teardown, `fetch` costs nothing and exercises the real HTTP stack including headers and status text. `supertest` earns its place when you have many endpoints and want terser assertions, or when a framework makes the listener harder to start directly. It hides a little of what is happening, which is a real cost in a learning project.

**Fixtures and factories.** Test data scattered inline gets painful fast; a factory is a function with sensible defaults you override per test:
```ts
// tests/factories.ts (sketch)
export function aTask(overrides: Partial<TaskWriteInput> = {}): TaskWriteInput {
  return { title: 'A task', description: null, priority: 'medium', completed: false, ...overrides };
}
// usage: await create(aTask({ title: '' })) -- only the field under test differs
```

Factories become essential the moment the schema has ten required fields, and they make a test read as "the thing that differs".

**Property-based testing** flips the direction of your assertions: you state a property that must hold for *all* inputs and the library hunts for counterexamples (`npm install --save-dev fast-check`).
```ts
it('never accepts a title longer than the limit', () => {
  fc.assert(fc.property(fc.string({ minLength: 201 }), (title) => {
    assert.throws(() => parseTaskWriteInput({ title }));
  }));
});
```

This is genuinely good at finding the inputs you did not think of -- Unicode edge cases, empty strings, enormous numbers -- which makes it a strong fit for a validator with real invariants.

**Testing against a real database.** An in-memory fake does not exercise your SQL, and SQL is where bugs hide. Either point the store at SQLite's `:memory:` (fast, real SQL, SQLite dialect) or use [`testcontainers`](https://node.testcontainers.org/) to start a real Postgres for the run (needs Docker, slower, and the only way to catch dialect differences before production does). A common compromise: fast SQLite unit tests on every save, and a small container-based integration suite in CI.

**Load testing** with [`autocannon`](https://github.com/mcollina/autocannon) or [`k6`](https://grafana.com/docs/k6/latest/): `npx autocannon -c 50 -d 10 http://127.0.0.1:3000/api/tasks`. Run this before and after the SQLite change from item 1. Watching p99 latency and event-loop lag move is the fastest way to understand the synchronous-driver trade-off described there.

---

## Tier 3: growing the codebase

### 10. Frameworks, and when to adopt one

**Effort: medium to migrate, and a one-way door for the plumbing.**
You now know exactly what a framework does, because you wrote a minimal version of it: `router.get` is a table of routes, middleware is a composed function chain, and `req.body` is a body parser.

| Framework | Model | Strengths | Costs and cautions |
| --- | --- | --- | --- |
| [Express](https://expressjs.com/) | Callback middleware, `(req, res, next)` | Ubiquitous, enormous ecosystem, most answers assume it | Older internals; async errors historically needed care (Express 5 handles rejected promises); sprawling optional types |
| [Fastify](https://fastify.dev/) | Plugin/encapsulation, JSON Schema at the core | Fast, schema-driven validation *and* serialization, good TypeScript support, logging built in | Its own idioms; encapsulation is powerful and initially confusing |
| [Hono](https://hono.dev/) | Web-standard `Request`/`Response` | Tiny, modern, runs on Node and edge runtimes; very readable middleware | Smaller ecosystem; edge portability has limits (no raw sockets, no `node:sqlite`) |
| [Koa](https://koajs.com/) | The onion model, `async (ctx, next)` | The cleanest expression of what `compose()` does; small core | Minimal by design, so you assemble more yourself; smaller community now |

What your code becomes, concretely:
```ts
// Fastify: route registration plus schema
fastify.post('/api/tasks', {
  schema: { body: { type: 'object', required: ['title'] }, response: { 201: TaskSchema } },
  handler: async (request, reply) => {
    const task = await store.create(request.body);
    reply.code(201).header('Location', `/api/tasks/${task.id}`).send(task);
  },
});
// Hono: Web-standard handlers, middleware that looks like ours
app.use('*', logger(), cors(), requestId());
app.get('/api/tasks', async (c) => c.json(await store.list(parseListQuery(c.req.query()))));
// Koa: our compose(), from the library that popularised it
app.use(async (ctx, next) => { /* ... */ await next(); });
```

**What you would lose.** This is the part "just use Fastify" skips. **Legibility:** every behavior becomes "the framework does that", so when `req.body` is undefined you debug someone else's parser instead of your own twenty lines. **Zero dependencies:** a framework's tree is dozens of packages you did not audit and do not control -- usually an acceptable trade, not a free one. **Precision:** the error envelope, the status-code choices and `X-Total-Count` are yours, and a framework will want to shape some of them. **This project's purpose:** if the goal is learning, the framework is the *next* project.
Adopt one when you have a requirement this code cannot meet comfortably -- a large route surface, content negotiation, WebSockets, real plugin composition, or a team that already knows Fastify. Do not adopt one to avoid writing 250 lines of router you already understand.

### 11. Project structure as it grows

**Effort: small to reorganise, ongoing to keep honest.**
The current layout is by **layer** (`routes/`, `middleware/`, `data/`, `validation/`, `http/`, `types/`), which is right at this size and makes the dependency direction obvious: HTTP at the edges, the store depending on nothing but types.

**Feature folders** (vertical slices) put everything about tasks in one directory -- routes, validation, store, types -- so a change touches one place and deleting a feature is deleting a folder. You lose the ability to see "every place that parses a body" at a glance, and cross-cutting changes now touch every feature. Keep the layer layout until you add a second resource and find yourself editing five directories to add one endpoint; there is no prize for choosing early.
```
src/
  tasks/     tasks.routes.ts  tasks.schema.ts  tasks.store.ts  tasks.types.ts
  users/     users.routes.ts  ...
  platform/  # shared: http, middleware, config, errors, logger
```

**When to introduce a service layer.** A handler that reads a body, validates, calls the store and responds is right when the logic is one call. A service earns its place when one endpoint must read two things, apply a rule, write one thing inside a transaction and send an email -- logic that belongs neither in the handler (HTTP) nor the store (data): `handler -> parses HTTP and decides status codes; service -> business rules, orchestration, transactions; store -> one table, one set of queries`.

**The anaemic-CRUD-layer trap** is a `TaskService` whose methods are one-line pass-throughs, such as `async getTask(id) { return this.store.findById(id); }`. Six of those and you have doubled the files while adding indirection. The rule of thumb: a service method should enforce a rule, combine operations, or own a transaction boundary. If it does none of those, delete it and let the handler call the store, exactly as this project does today.

### 12. API documentation

**Effort: small hand-written, medium to generate from schemas.**
Doc comments and the README are fine for you and useless for a consumer who wants to try a request. **OpenAPI 3.1** is the machine-readable description, and once you have one you get browsing UIs, generated clients and contract tests.
```yaml
# A fragment of the document (sketch).
openapi: 3.1.0
info: { title: dev_node-api, version: 1.0.0 }
paths:
  /api/tasks:
    get:
      summary: List tasks
      parameters:
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
      responses:
        '200':
          description: A page of tasks
          headers:
            X-Total-Count: { schema: { type: integer } }
          content:
            application/json:
              schema: { type: array, items: { $ref: '#/components/schemas/Task' } }
```

Two ways to produce it, with a real trade-off. **Generate from schemas:** if you adopt Zod (items 4 and 5) you can derive JSON Schema from the same schemas that validate requests -- Zod emits JSON Schema directly, and [`zod-to-openapi`](https://github.com/asteasolutions/zod-to-openapi) adds the path and parameter scaffolding. The document cannot drift from the validators, because they are the same source. **Hand-write or generate from JSDoc:** fine while validation is hand-written, but the document becomes a second implementation of your rules and nothing fails when the two disagree.

**Browsing** uses [Swagger UI](https://swagger.io/tools/swagger-ui/) or, more pleasant to look at, [Scalar](https://scalar.com/). **Generating a client** from the document ([`openapi-typescript`](https://openapi-ts.dev/)) is the real payoff: a front end that cannot call a renamed field without a compile error.

**.http files** are dramatically cheaper than all of the above and worth doing this week:
```http
### List high-priority tasks
GET http://127.0.0.1:3000/api/tasks?priority=high&limit=5

### Create a task
POST http://127.0.0.1:3000/api/tasks
Content-Type: application/json
{ "title": "Write the docs", "priority": "high" }
```

VS Code's REST Client extension and JetBrains IDEs both understand the format. Commit them next to the code, run them with one keystroke, and let them double as executable examples in the README.

### 13. Caching and conditional requests

**Effort: medium, because correctness is the hard part.**
`src/middleware/defaultHeaders.ts` sets `Cache-Control: no-store` and explains why: the data is mutable and a cached `GET /api/tasks` would hand a user a stale list. That reasoning is correct, and it is also a decision to never use HTTP caching at all, which costs bandwidth and latency.

**`ETag`** is a version identifier for a representation; the client sends it back in `If-None-Match` and a match means `304 Not Modified` with no body.
```ts
// src/middleware/etag.ts (sketch)
export function createEtag(): Middleware {
  return async (ctx, next) => {
    await next();
    // Sketch simplification: this hashes the transmitted body, which means buffering the
    // response. For large responses hash the *inputs* instead -- for a task its
    // `updatedAt` is a perfectly good version identifier and costs nothing.
    ctx.res.setHeader('ETag', tag);
    if (ctx.req.headers['if-none-match'] === tag) {
      ctx.res.statusCode = 304; // must not include a body; ETag and Cache-Control stay
      ctx.res.end();
    }
  };
}
```

`Last-Modified` with `If-Modified-Since` is the coarser alternative: cheaper to produce, less precise (one-second granularity, and it cannot distinguish two changes in the same second). `ETag` is usually better for JSON.

**When is something other than `no-store` correct?** Exactly when you can answer "how long may a cache hold this, and what invalidates it?" For this API: `Cache-Control: private, no-cache` on `GET /api/tasks/:id` means "store it, but revalidate every time", which with an `ETag` is a cheap 304 and no retransmitted body -- a strict improvement over `no-store` with no staleness risk. `private` matters once authentication exists, because it forbids shared caches such as CDNs and corporate proxies from storing a response that could later be served to a different user; `public, max-age=60` is only safe for data genuinely identical for everyone that tolerates a minute of staleness.
What would have to change here: add an `ETag` to task responses, stop sending `no-store` for GETs, keep it for writes (`POST` responses are not cacheable anyway), and add `Vary` on `Authorization` once requests are authenticated -- the same reasoning that already puts `Vary: Origin` in the CORS middleware. Node's own `http` module generates no `ETag` for you (Express does, via the `etag` package), and nothing in this project sets one today.

### 14. API versioning

**Effort: small to implement, large to live with.**
**URL versioning** (`/api/v1/tasks`) is visible, trivially routable, and easy to cache and log separately; the cost is that every URL in every client, doc and bookmark carries the version. **Header versioning** (`Accept: application/vnd.dev-node-api.v2+json`, or a custom `API-Version` header) keeps URLs clean and treats the representation as the negotiated thing, which is arguably more correct HTTP; it is harder to test by hand and easy to forget in a client.

**Do not version until you must.** A version number is a promise to maintain the old one, and the first version you publish is one you can never take back. Until you have external consumers you cannot coordinate with, prefer **additive, backward-compatible change**: add an optional field, add an endpoint, add a query parameter. Note that this project rejects unknown body fields deliberately -- good for catching typos, and it means adding a field is the only safe direction, since removing one breaks clients. The trigger for versioning is a breaking change you cannot avoid: renaming a field, changing a type, changing what a status code means. When that day comes, mounting `/api/v2/` from a separate router alongside the old one is the least confusing option, even if it is the least elegant.

### 15. Observability

**Effort: medium.**
Logging (item 3) tells you what happened to one request. Observability is the aggregate: is the service healthy, is it slowing down, where is the time going.

**Metrics in Prometheus format** via [`prom-client`](https://github.com/siimon/prom-client). The three types that matter are counters (requests, errors -- monotonic), gauges (in-flight requests, memory) and histograms (duration, which gives percentiles).
```ts
// src/metrics.ts (sketch)
export const registry = new Registry();
collectDefaultMetrics({ register: registry }); // event loop lag, heap, GC
export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Request duration in seconds',
  labelNames: ['method', 'route', 'status'], // keep label cardinality LOW
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});
```

Expose it at `GET /metrics` (not publicly -- it leaks your architecture and load) with `ctx.res.setHeader('Content-Type', registry.contentType); ctx.res.end(await registry.metrics());`.
The classic mistake is labelling by the raw URL: `/api/tasks/abc-123` and `/api/tasks/def-456` become separate time series and cardinality explodes until Prometheus falls over, so label by the *route pattern* (`/api/tasks/:id`) -- the router would need to publish the pattern on the context. **OpenTelemetry** tracing goes further: a propagated trace ID shows one request's path through a distributed system as a waterfall of spans. More setup than metrics for one service, and the only thing that works once a request touches five services.

**Splitting liveness from readiness is the item here most likely to cause an outage if you get it wrong.** `/health` (liveness) means "the process is running and its event loop is responsive" and must not touch the database, the network, or anything that can fail independently -- if it does, a momentary database blip makes the orchestrator kill and restart every healthy process, which fixes nothing and adds a cold start. `/health/ready` (readiness) means "I can serve traffic now" and *should* check dependencies: a `SELECT 1`, that migrations have run, that config is loaded. A failing readiness probe removes the instance from the load balancer without killing it, so it can recover. Conflating them is how a slow dependency becomes a restart loop, and `src/routes/health.routes.ts` already argues for exactly this split in its header comment.

### 16. Background work and longer-running operations

**Effort: medium for the pattern, large for a real queue.**
The rule is simple: **do not do slow work inside a request handler.** A 30-second request holds a connection, a socket and (with a synchronous store) potentially the event loop; the client may have given up long before you finish and you will never know.

**The 202 pattern** is the standard answer: validate the work, enqueue it, return immediately with a pointer to the result.
```http
POST /api/tasks/report
-> 202 Accepted
   Location: /api/tasks/report/8f14e45f-ceea-467a-9b6f-2e4c3f1a7d90
GET /api/tasks/report/8f14e45f-...
-> 200 { "status": "pending" }
-> 200 { "status": "complete", "url": "/downloads/report-8f14.csv" }
-> 200 { "status": "failed", "error": "..." }
```

Note the deliberate choices: `202` rather than `200` because the work is not done; `Location` pointing at the status resource, reusing the header `POST /api/tasks` already uses; and a status enum rather than a boolean, so failure is representable.

**Job queues, honestly compared.** A **table in your existing database** (`status`, `run_at`, `attempts`, a polling worker) needs no new infrastructure and can enqueue in the same transaction as the write that requires it, at the cost of polling latency and database load; this is the right answer surprisingly often. **`BullMQ` with Redis** is purpose-built with delayed jobs, retries, concurrency control and a UI, but adds a process to run and monitor, and the queue is no longer transactional with your database, so a crash between the write and the enqueue loses the job. A **hosted queue** such as SQS gives managed reliability and scaling in exchange for a cloud dependency and an emulator for local development. **In-process `setTimeout`** is fine for a learning exercise and loses the job on restart -- worth knowing why it is wrong rather than not knowing the option.
Whichever you pick you need the same four things: **retries** with backoff, **idempotency** (a retried job must not send the email twice -- a unique job key makes that enforceable), **visibility** (what is queued, running, failing) and **dead-letter handling** for jobs that fail forever.

### 17. Deployment

**Effort: medium, and most of it is understanding rather than typing.**
```dockerfile
# syntax=docker/dockerfile:1

# ---- Build stage: devDependencies and the TypeScript compiler ----
FROM node:24-slim AS build
WORKDIR /app
# Copy manifests first so `npm ci` is only re-run when the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage: no compiler, no devDependencies, no source ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=dev because typescript and @types/node are not needed at runtime.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The official Node image has an unprivileged `node` user. Running as root inside
# a container means a container escape is a root escape.
USER node
EXPOSE 3000
# HEALTHCHECK is how Docker (and Compose, and some orchestrators) knows whether the
# container is usable. Point it at LIVENESS, not readiness.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
```

Why `node:24-slim`: it is Debian-based, so glibc stays and prebuilt native modules work. The `-alpine` images are smaller but use musl libc, so many native packages must be compiled from source (slower builds) and occasionally misbehave. With no native dependencies either works, and `slim` is the choice that will not surprise you later. The full `node:24` image is about a gigabyte and carries a build toolchain you do not need at runtime.

- **`npm ci`, not `npm install`.** `ci` installs exactly what the lockfile specifies and fails if the two disagree; `install` may silently update them. Builds want reproducibility.
- **`NODE_ENV=production`** makes libraries take their production paths.
- **`SIGTERM` handling** is easy to miss and matters most. In a container Node runs as PID 1; Kubernetes (or `docker stop`) sends `SIGTERM`, waits a grace period (30 seconds by default), then sends `SIGKILL`. Your `server.ts` already handles `SIGTERM` with `closeIdleConnections()` and a forced close after the grace period. The classic failure is a process that ignores `SIGTERM`, gets `SIGKILL`ed, and drops every in-flight request on every deploy. PID 1 also has an obligation to reap zombie children, which Node does not always do correctly, so `docker run --init` or an init process in the orchestrator is worth adding.
- **Graceful shutdown and readiness during rollout.** On `SIGTERM` the correct order is: fail the readiness probe so the load balancer stops sending new requests; keep serving what is in flight; then close the server and the database connections. Going straight to closing creates a burst of `502`s on every deploy, which is why the two probes are different endpoints.
- **Environment-based configuration.** Everything `src/config.ts` reads is the right way to configure a container: `PORT`, `HOST`, `DATABASE_URL`, `LOG_LEVEL`, `CORS_ORIGIN`. Secrets come from the orchestrator's secret store, never the image. `--env-file-if-exists=.env` is for local development; in a container the variables arrive from the environment directly.

### 18. Continuous integration

**Effort: small.**
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc   # this project already pins Node here
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

**Why `npm run typecheck` must be its own step, and why this is the most important paragraph in this section.** Node **strips** types; it does not **check** them. `node --test` runs the suite through the type stripper, which deletes every annotation and runs what remains, so a file full of type errors executes happily:
```ts
// src/broken.ts
const answer: string = 42;
console.log(answer); // prints 42; no error anywhere
```
```bash
node src/broken.ts   # runs fine
npx tsc --noEmit     # errors
```

The consequence for CI is direct: **a green test suite does not mean your types are sound.** If the pipeline runs only `npm test`, code that fails `tsc` merges to main and nobody finds out until someone notices a wrong assumption turning into a runtime bug -- exactly the failure the annotations were supposed to prevent. `npm run typecheck` is a separate step because it is a separate program answering a separate question, and it should never be folded into the test step.
The other two are cheap: `npm run build` proves the project still emits valid JavaScript to `dist/` (the code path production uses, and a different one from type stripping), and `npm ci` proves the lockfile agrees with `package.json`. Once the basics are green, consider a matrix across `windows-latest` and `ubuntu-latest` (this project's docs contain Windows-specific advice; you want to know if it is still true), coverage reporting, and a Docker build step so a broken Dockerfile fails in CI rather than at deploy time.

---

## A suggested order to actually do these in

| # | Step | Why here |
| --- | --- | --- |
| 1 | **`node:sqlite` behind the existing store interface** (1a) | Durable data is the prerequisite for everything else; it is one new file and one changed line in `app.ts`, and it proves the repository pattern works |
| 2 | **CI: `npm ci`, typecheck, test, build** (18) | Set it up before the codebase grows, and the typecheck step has to exist before you start trusting green tests |
| 3 | **Structured logging with request IDs** (3) | Every later step is easier to debug when you can see what happened, and a request ID is what makes a bug report actionable |
| 4 | **Config validation with Zod** (4) | Small, and it teaches the library and the `safeParse` idiom you reuse in step 6 |
| 5 | **Sorting and cursor pagination** (2) | Finish the persistence work while the SQL is fresh; `?sort=` plus keyset paging is where SQLite stops being obviously sufficient and starts teaching you about indexes |
| 6 | **Validation library for request bodies** (5) | With Zod known from step 4, replacing 544 hand-written lines is a confident afternoon, and it makes item 12 nearly free |
| 7 | **Authentication plus owner scoping** (6) | The first genuinely security-relevant work, and where the API starts resembling something deployable |
| 8 | **Rate limiting, timeouts, and the CORS origin** (7 and 8) | The remaining "someone will abuse this" gaps, all small, and best done together because they share the middleware pipeline |

After those: Docker (17) before observability (15), because running in a container is what makes the liveness/readiness distinction concrete. Testing depth (9) fits anywhere and is most valuable right after step 1, when the SQL is new. Frameworks (10), versioning (14) and a service layer (11) are answers to problems you do not have yet -- let the codebase ask for them.

## Resources worth your time

Primary sources, not tutorials. Each is worth reading for a specific reason.

**HTTP**

- [MDN: HTTP reference](https://developer.mozilla.org/en-US/docs/Web/HTTP) -- the reference to keep open while working on this API. Start with the [response status codes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status) and read the ones this project uses; the [headers reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers) answers questions like "which header should carry a total count".
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html) -- the normative specification for methods, status codes and headers, and the source of the rules this project's comments keep appealing to (why PUT must be idempotent, what 204 means, what `Allow` is for). Read the sections relevant to what you are implementing rather than cover to cover.
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html) -- everything needed for item 13: `Cache-Control` directives, freshness, validation, and the precise semantics of `ETag` and `304`. Read this before writing caching middleware, because the corner cases are real.
- [RFC 6585: Additional HTTP Status Codes](https://www.rfc-editor.org/rfc/rfc6585.html) -- short, and it is where `429 Too Many Requests` is actually defined, including `Retry-After`.

**Node.js**

- [Node.js documentation](https://nodejs.org/docs/latest-v24.x/api/) -- use the version-specific docs for the Node you actually run, not "latest"; several APIs relevant here changed status recently.
- [`http`](https://nodejs.org/api/http.html) -- `IncomingMessage`, `ServerResponse`, `createServer`, and the timeout properties from item 8. `src/http/response.ts` uses a small fraction of it, so reading the whole API is worthwhile.
- [`stream`](https://nodejs.org/api/stream.html) -- the mental model behind `readJsonBody`'s `for await (const chunk of req)`. Backpressure and async iteration make the rest of this document make sense.
- [Test runner](https://nodejs.org/api/test.html) -- `node:test` is far more capable than this project uses: mocking, snapshots, coverage, watch mode, filtering. Read the coverage section before reaching for a test framework.
- [`node:sqlite`](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) -- the API for item 1a, linked to the v24 line on purpose: on Node 24 the classes are `DatabaseSync` and `StatementSync`, so read this version rather than whatever `nodejs.org/api/sqlite.html` serves by default. Read the type conversion table carefully: booleans become `0`/`1` and read back as numbers, exactly the boundary detail that causes a subtle bug.
- [Modules: TypeScript](https://nodejs.org/api/typescript.html) -- how Node executes `.ts` files and what it does and does not support. This is the page behind item 18's argument that typechecking cannot be skipped.

**TypeScript**

- [The TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html) -- read "Narrowing", "Generics" and "Utility Types". Narrowing is the theory behind `src/validation/task.validation.ts`, where the type predicates do the work.
- [tsconfig reference](https://www.typescriptlang.org/tsconfig/) -- for the flags this project sets deliberately: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`. Knowing what each buys you is how you decide whether to keep it.

**Security**

- [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) -- the canonical list of what actually goes wrong in APIs. Broken object-level authorization is number one, and item 6 here is a direct response. All ten are short.
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) -- concrete algorithm and parameter recommendations. Read it before implementing password hashing.
- [OWASP JSON Web Token for Java cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html) -- ignore "for Java"; the vulnerabilities it catalogues (algorithm confusion, `alg: none`, missing verification) are language-independent.
- [MDN: HTTP response status codes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status) -- listed again because it is the fastest way to check that your choice of 400 versus 422 versus 409 matches what everyone else means by those codes.

---

One last thought. The most valuable thing about this codebase is not that it is small; it is that every mechanism is visible. You can point at the line that parses a body, the line that matches a route, and the line that turns a thrown error into a 404. Whatever you build next, keep asking which layer a change belongs to -- the answer is usually clearer than it feels, and this project's structure is a good default to copy when it is not.
