# TypeScript for JavaScript Developers

You already know how to write this program. Everything here is about writing down the types you
were already keeping in your head.

Nothing below explains callbacks, promises, closures, classes, or `async`/`await`. What is new is
that a second program — a **type checker** — reads your code, and that this project runs the `.ts`
files through Node with the types thrown away.

Examples target the settings this project actually uses: TypeScript 5.9+, `strict`,
`noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, and
`module`/`moduleResolution` set to `nodenext`. Where an example is meant to error, a comment says so.

## 1. What TypeScript actually is

TypeScript is JavaScript plus a type syntax. That is the whole idea.

- **It is a superset.** Every valid JavaScript file is a valid TypeScript file.
- **It is a compile-time tool.** Types are for the checker, not a runtime feature.
- **Types do not exist at runtime.** No reflection, no metadata. After the types are removed, what
  runs is plain JavaScript — essentially what you would have written by hand.

In plain JavaScript the type lives in a comment and in your memory:

```js
// plain JS: "returns a string" is a comment, not a rule
function formatHost(host, port) {
  return `${host}:${port}`;
}
```

In TypeScript you write the same function and the fact becomes something the checker enforces:

```ts
function formatHost(host: string, port: number): string {
  return `${host}:${port}`;
}
```

## 2. The two jobs of TypeScript

This is the most important section in the file. TypeScript has **two separate jobs**, done by **two
different programs** that never talk to each other.

| Job | Program | What it does |
| --- | --- | --- |
| **1. Checking** | `tsc` | Reads your annotations and reports mistakes |
| **2. Erasing** | Node's type stripper (or `tsc` emitting `.js`) | Deletes the annotations and runs the rest |

Node 24 executes `.ts` files directly. It parses the file, **strips** every type annotation,
`interface`, `type` alias, and type-only import, and runs what remains. That is **type stripping**,
and it is why this project needs no build step and no dependencies to develop.

The consequence: **type stripping removes types; it does not check them.** Node skips annotations
the way it skips comments. A file full of type errors runs happily until one of those wrong
assumptions crashes the program.

### A worked example: broken code that runs fine

```ts
// src/broken.ts
const answer: string = 42;

console.log("ran anyway:", answer);
```

```bash
node src/broken.ts
# ran anyway: 42
```

It prints `42` and exits `0`. Node deleted `: string` and ran `const answer = 42;`. The annotation
was a lie and Node did not care. Now ask the checker — the second, independent program:

```bash
npm run typecheck
# src/broken.ts:1:7 - error TS2322: Type 'number' is not assignable to type 'string'.
```

Node says "ran it." `tsc` says "this is wrong." Both are right, because they answer different
questions. A more realistic version — a wrong argument type that silently produces garbage:

```ts
function add(a: number, b: number): number {
  return a + b;
}

console.log(add(1, "2"));
```

```bash
node src/broken-sum.ts
# 12   <- no error; JS string concatenation, exactly as in plain JavaScript
npm run typecheck
# error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
```

The return type says `number`; the runtime produced a `string`. **Running the code proves nothing
about its types** — a green run only means the paths you exercised happened to work. You must run
the checker deliberately, and validation of outside data has to be written by hand, because types
are gone by then (Sections 5, 6, and 10).

## 3. How to annotate

```ts
const host: string = "127.0.0.1";
const port: number = 3000;
const verbose: boolean = false;
```

Lowercase for the type. `String`, `Number`, and `Boolean` also exist but are the wrapper object
types; using them is almost always a mistake. There is no `int` or `float` — `number` covers both,
as in JavaScript.

### Arrays and tuples

```ts
const names: string[] = ["ada", "grace"];

const frozen: readonly string[] = ["a", "b"];
frozen.push("c");   // error: Property 'push' does not exist on type 'readonly string[]'.

const pair: [string, number] = ["age", 42];   // tuple: fixed length, per-position types
pair[0];            // string
pair[2];            // error: Tuple type '[string, number]' of length '2' has no element at index '2'.
```

Prefer `string[]` over `Array<string>`. Use `readonly T[]` for arrays you never mutate, and tuples
when position carries meaning (`[key, value]`).

### Objects

```ts
interface ServerConfig {
  host: string;
  port: number;
  timeoutMs?: number;      // optional: the key may be absent entirely
  readonly name: string;   // readonly: cannot be reassigned after creation
}

const cfg: ServerConfig = { host: "localhost", port: 3000, name: "main" };

cfg.port = 8080;    // ok
cfg.name = "other"; // error: Cannot assign to 'name' because it is a read-only property.
```

`cfg` omits `timeoutMs` and that is allowed, because of the `?`. Note that `readonly` is shallow:
`readonly items: string[]` still lets you `push`. Inline object types are fine for a shape used
once (`const config: { host: string } = ...`); name it once it is used twice, which is the type
equivalent of extracting a variable.

### Functions, optional and default parameters

```ts
function formatHost(host: string, port: number): string {
  return `${host}:${port}`;
}

// optional: callers may omit it; inside, the type is number | undefined
function connect(host: string, port?: number): string {
  return port === undefined ? host : `${host}:${port}`;
}

// default: callers may omit it, but inside, the type is number
function connect2(host: string, port = 3000): string {
  return `${host}:${port}`;   // port is never undefined here
}
```

That is why `connect` needs an `undefined` check and `connect2` does not. A required parameter
cannot follow an optional one: `function bad(a?: number, b: string): void {}` fails with *A
required parameter cannot follow an optional parameter.*

### Inference: annotate boundaries, infer internals

```ts
const port = 3000;                     // type: 3000 (const keeps the literal type)
let retries = 3000;                    // type: number (let widens)
const names = ["ada", "grace"];        // string[]
const env = { host: "x", port: 3000 }; // { host: string; port: number } (properties widen)
const doubled = [1, 2, 3].map((n) => n * 2); // n is number by contextual typing
```

Two details worth internalizing: `const` keeps the literal type while `let` widens it, and callback
parameters like `n` need no annotation because the element type flows in.

> **Annotate boundaries. Infer internals.**

**Annotate** function parameters and the return type of anything exported — those are your
contracts. **Annotate** data entering the module from outside: parsed JSON, request bodies,
environment variables (Sections 5, 6, 10). **Infer** locals, intermediates, and short callbacks.
Leaving a parameter unannotated is not tolerated under `strict`:

```ts
function double(n) { return n * 2; }
// error TS7006: Parameter 'n' implicitly has an 'any' type.
```

## 4. `interface` vs `type`

Both introduce a name for a type. Use the table rather than folklore:

| Capability | `interface` | `type` |
| --- | --- | --- |
| Describe an object shape | Yes | Yes |
| Compose | `extends` | `&` (intersection) |
| Alias a union, primitive, tuple, or function | No | Yes |
| Declaration merging | Yes | No (error) |
| Generic type parameters | Yes | Yes |
| Usable with `implements` | Yes | Yes, if it is an object type |

```ts
interface User { id: string; name: string }
interface Admin extends User { permissions: string[] }

type AdminAlias = User & { permissions: string[] };   // same shape, other spelling

type Id = string | number;              // only `type` can express a non-object
type Handler = (value: string) => void;
```

Two real differences. First, **interfaces extend with a conflict check; intersections produce
`never`**:

```ts
interface A { value: string }

interface Broken extends A { value: number }
// error: Interface 'Broken' incorrectly extends interface 'A'.

type NotBroken = A & { value: number };
const x: NotBroken = { value: 1 };
// error: Type 'number' is not assignable to type 'never'.
```

The interface caught the contradiction at the declaration; the intersection accepted it and failed
later, at the assignment. Second, **interfaces merge** when declared twice — a feature that exists so
libraries can let consumers add to their types. Treat two declarations of the same interface in one
application code base as a mistake.

**Guidance:** use an `interface` for the shape of an object that is passed around, implemented, or
extended. Use a `type` when you need a union, tuple, or function alias. When either would do, pick
one and be consistent — inconsistency is the actual cost.

### Discriminated unions

The most valuable pattern in day-to-day TypeScript: a union of object shapes sharing one
literal-typed field that tells them apart. In plain JavaScript you return `{ ok: true, value }` or
`{ ok: false, error }` and trust the caller to check `ok`. The shape is a convention. Here it is
enforced.

```ts
type Result<T> =
  | { kind: "ok"; value: T }      // `kind` is the discriminant
  | { kind: "error"; message: string };

type User = { id: string; name: string };

function display(result: Result<User>): string {
  switch (result.kind) {
    case "ok":
      return result.value.name;    // TypeScript knows value exists here
    case "error":
      return result.message;       // ...and that message exists here
  }
}
```

`kind` holds a *literal* type — not `string`, but exactly `"ok"` or `"error"` — which is what lets
the checker narrow. Inside `case "ok"`, `result.value` is available and `result.message` is not;
inside `case "error"`, the reverse. Illegal states become unrepresentable rather than discouraged.

## 5. Union types, literal types, and narrowing

A **union** means "one of these": `string | number`. A **literal type** means "exactly this value":
`"active"`. Union + literal + narrowing is how TypeScript models what JavaScript models with `if`
statements and hope.

```ts
function describe(value: string | number): string {
  if (typeof value === "string") {
    return value.toUpperCase();   // narrowed to string
  }
  return value.toFixed(2);        // narrowed to number
}

type Cat = { meow: () => void };
type Dog = { bark: () => void };

function speak(pet: Cat | Dog): void {
  if ("meow" in pet) pet.meow();  // `in` narrows by property presence
  else pet.bark();
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;   // `instanceof` narrows by class
  if (typeof err === "string") return err;
  return "Unknown error";
}
```

Narrowing is control-flow aware, so early returns, discriminants, and truthiness work too:

```ts
function lengthOf(value: string | string[] | null): number {
  if (value === null) return 0;                       // from here, no null
  if (typeof value === "string") return value.length;
  return value.length;                                // string[]
}

if (result.kind === "ok") {
  result.value;   // narrowed to the "ok" variant
}

function label(name: string | null | undefined): string {
  if (!name) return "anonymous";   // narrows out "", null, and undefined
  return name;
}
```

`instanceof` is essential in `catch` blocks, because `strict` makes caught errors `unknown`.

### User-defined type guards (`is`)

`typeof` and `in` only know JavaScript-level facts. To validate the *shape* of foreign data, write a
predicate returning `value is T`:

```ts
interface ApiUser {
  id: string;
  name: string;
}

function isApiUser(value: unknown): value is ApiUser {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["id"] === "string" && typeof candidate["name"] === "string";
}

const raw: unknown = JSON.parse(body);

if (isApiUser(raw)) {
  raw.name;   // string — narrowed by the guard
}
```

The `value is ApiUser` return type is a promise to the compiler and it is **unchecked** — whatever
your body does, TypeScript believes the claim. Get the body right. The reward is that callers stop
needing assertions.

### A realistic `unknown` -> narrowed example

Environment variables arrive as `string | undefined` and must be interpreted before use:

```ts
function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env["PORT"];        // string | undefined
  if (raw === undefined) {
    return 3000;                  // sensible default
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`PORT must be a positive integer, received "${raw}"`);
  }

  return parsed;                  // number, guaranteed by the checks above
}
```

Every branch is accounted for: absent, present-but-invalid, present-and-valid. Almost all
configuration and payload validation takes this shape — check the untrusted value, then hand on a
type you trust.

## 6. `any`, `unknown`, and `never`

Getting these three right prevents most "why did TypeScript not catch this?" moments.

| Type | Meaning | Can you use it? | Assignable |
| --- | --- | --- | --- |
| `any` | "Stop checking." | Anything, unchecked | To and from everything |
| `unknown` | "I do not know this yet." | Nothing until narrowed | Accepts anything; assignable only to `unknown`/`any` |
| `never` | "This cannot happen." | Nothing — uninhabited | To everything; only `never` assigns to it |

### `any` silently disables checking for everything it touches

```ts
const parsed = JSON.parse(body);   // JSON.parse returns `any`

parsed.user.name.first;            // no error
parsed.thisMethodDoesNotExist();   // no error
const port: number = parsed;       // no error
```

No error on any line, and that is the whole danger. `any` does not merely permit a mistake on one
line; it removes checking from every value derived from it. `parsed.user` is `any`,
`parsed.user.name` is `any`, and so on. One `any` at the edge of a program can un-type a large
fraction of it.

`noImplicitAny` (part of `strict`) cannot help here, because this `any` is explicit — it is
`JSON.parse`'s declared return type. So the burden is on you:

```ts
const parsed: unknown = JSON.parse(body);

parsed.user;   // error: 'parsed' is of type 'unknown'.

if (!isApiUser(parsed)) {
  throw new Error("Invalid user payload");
}

parsed.name;   // string — proven, not asserted
```

Any value can be *assigned into* `unknown`, even an `any`, so the dangerous type is contained at the
boundary instead of flowing through the program. **Rule for this project: `JSON.parse` output,
request bodies, file contents, environment variables, and anything from `catch` are `unknown` until
validated.** If you reach for `any`, the honest options are usually `unknown` plus a guard, or a real
interface plus a guard.

### `never` marks impossible states

`never` is what a function returns when it does not return at all, and its practical use is
exhaustiveness checking: the checker narrows a discriminated union to `never` once every case is
handled, so a missing case becomes a compile error.

```ts
function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}

type ParseResult =
  | { kind: "ok"; port: number }
  | { kind: "missing"; key: string }
  | { kind: "invalid"; key: string; received: string };

function describe(result: ParseResult): string {
  switch (result.kind) {
    case "ok": return `port ${result.port}`;
    case "missing": return `missing ${result.key}`;
    case "invalid": return `invalid ${result.key}: ${result.received}`;
    default: return assertNever(result);   // result is never here
  }
}
```

Add a fourth variant and forget to handle it, and `default` stops compiling — the compiler tells you
exactly which function you forgot to update. It also appears when a check is contradictory: inside
`if (typeof x === "string" && typeof x === "number")`, `x` is `never`, because no value is both.

## 7. Generics

Generics preserve a relationship between types that you already express in JavaScript by *using* a
value in two places.

```js
// plain JS
function firstOrNull(items) {
  return items.length > 0 ? items[0] : null;
}
```

You know that `firstOrNull([1, 2, 3])` gives back a number. That input/output relationship is real
but unwritten. Writing it naively as `(string | number)[] -> string | number | null` loses it,
because the caller can no longer tell what comes out. A **type parameter** keeps the relationship:

```ts
function firstOrNull<T>(items: T[]): T | null {
  return items.length > 0 ? items[0] ?? null : null;
}

const a = firstOrNull([1, 2, 3]);         // number | null
const b = firstOrNull(["ada", "grace"]);  // string | null
const c = firstOrNull<number>([]);        // number | null (explicit; inference had nothing to go on)
```

Read `<T>` as "for any type `T`". The `?? null` is not decoration: because
`noUncheckedIndexedAccess` is on, `items[0]` is `T | undefined` even after the length check, so
`?? null` produces the `T | null` the signature promises (Section 8).

If you know generics from other languages, note what is different here: **they are erased.** No
`typeof T`, no `new T()`. `<T>` exists only during checking, which is why it costs nothing at
runtime.

### Generic constraints (`extends`)

An unconstrained `T` can be anything, so you cannot use it. `extends` states the minimum a type must
provide and *grants* access to those members:

```ts
function indexById<T>(items: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.id, item);   // error: Property 'id' does not exist on type 'T'.
  }
  return map;
}
```

```ts
function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.id, item);   // ok: T is guaranteed to have `id`
  }
  return map;
}

interface Row { id: string; label: string }

const rows: Row[] = [{ id: "a", label: "first" }];
const byId = indexById(rows);   // Map<string, Row> — the caller keeps its full type
```

`T extends { id: string }` does not mean "T is a subclass of." It means "T must be assignable to
this shape" — structural typing, the same way any object works with a JavaScript function that only
reads `.id`. A second parameter constrained by `keyof` is the other workhorse shape:

```ts
function pluck<T, K extends keyof T>(items: T[], key: K): T[K][] {
  return items.map((item) => item[key]);
}

pluck(rows, "label");   // string[]
pluck(rows, "nope");    // error: Argument of type '"nope"' is not assignable to parameter of type 'keyof Row'.
```

### Generic interfaces

```ts
interface Repository<T extends { id: string }> {
  findById(id: string): Promise<T | undefined>;
  save(entity: T): Promise<void>;
}

interface User { id: string; name: string }

class InMemoryUserRepository implements Repository<User> {
  readonly #rows = new Map<string, User>();

  async findById(id: string): Promise<User | undefined> {
    return this.#rows.get(id);
  }

  async save(entity: User): Promise<void> {
    this.#rows.set(entity.id, entity);
  }
}
```

`Repository<User>` is a checked promise that these methods accept and return `User`. Type parameters
may also have defaults, which is what makes `Map<K, V>` and `Array<T>` comfortable:
`type Envelope<T = unknown> = { data: T };`

You will *read* far more advanced generics than you write. Conditional and mapped types compute new
types from old ones — `type Nullable<T> = { [K in keyof T]: T[K] | null }`,
`type ElementType<T> = T extends readonly (infer U)[] ? U : never`. These are what make library
types like `Partial<T>`, `Pick<T, K>`, `Record<K, V>`, `ReturnType<F>`, and `Awaited<T>` work. Use
those built-ins when you need this kind of thing; writing your own is a later topic. Recognize the
syntax, do not start there.

## 8. `strictNullChecks` and the `undefined` / `null` discipline

This setting changes daily code the most and produces the most new errors for a JavaScript
developer. Without it, `null` and `undefined` are assignable to everything:

```ts
// if strictNullChecks were off, this would be legal
let name: string = "ada";
name = undefined;    // ok
name.toUpperCase();  // compiles — and crashes at runtime
```

With `strict: true` they become their own types, not members of `string`. The new errors are the
compiler finding the places where a JavaScript program would throw
`TypeError: Cannot read properties of undefined`.

```ts
interface Session {
  user?: { id: string };
}

const session: Session = {};

session.user.id;                 // error TS18048: 'session.user' is possibly 'undefined'.
const id = session.user?.id;     // string | undefined  — optional chaining short-circuits
const id2 = session.user?.id ?? "anonymous";   // string — nullish coalescing supplies a default
```

`?.` short-circuits the chain to `undefined` if anything before it is nullish. It does not make the
result safe — it makes it *honestly optional*, and the type says so. `??` supplies a default only for
`null`/`undefined`, whereas `||` also fires on `0`, `""`, and `false`:

```ts
const port = 0;
const a = port || 3000;   // 3000 — probably not what you wanted
const b = port ?? 3000;   // 0    — the value survived
```

### `noUncheckedIndexedAccess`: why `arr[0]` is possibly `undefined`

By itself `strict` assumes indexed access always succeeds. That assumption is wrong: reading past
the end of an array gives `undefined`, and so does a missing key. This project matches reality:

```ts
const names = ["ada", "grace"];

const first = names[0];              // string | undefined  (not string)
const safe = names[0] ?? "nobody";   // string
const asserted = names[0]!;          // string — an assertion; see Section 10

const cache: Record<string, string> = {};
const hit = cache["user:1"];         // string | undefined
```

This eliminates a whole family of bugs, and it conflicts with one habit: a classic indexed `for`
loop now needs a fallback or guard. Prefer iteration, which yields the element type directly:

```ts
for (const name of names) {
  name.toUpperCase();   // string, no guard needed
}
```

### `useUnknownInCatchVariables`

Also from `strict`: `catch (err)` gives `unknown`, not `any`, so the `instanceof` narrowing from
Section 5 is the tool you need. In JavaScript a caught value is anything at all; `unknown` forces
the check.

```ts
try {
  JSON.parse("not json");
} catch (err) {
  if (err instanceof Error) console.error(err.message);
}
```

### The one strict-family flag `strict` does not turn on

`strict: true` enables `strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`,
`strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`,
`useUnknownInCatchVariables`, and `alwaysStrict`. It does **not** enable
`noUncheckedIndexedAccess` or `exactOptionalPropertyTypes`, which is why `noUncheckedIndexedAccess`
appears explicitly in `tsconfig.json`.

`exactOptionalPropertyTypes` is the one this project leaves **off**. With it enabled, `?` means "the
key may be absent" and nothing more, so passing an explicit `undefined` is rejected:

```ts
interface Options {
  retries?: number;
}

// With exactOptionalPropertyTypes: true this is an error;
// with it off (current setting) it is allowed.
const a: Options = { retries: undefined };
```

Enabling it is a one-line change and gives a stricter reading of "optional". The fix for a
deliberate undefined is to widen the type yourself: `retries?: number | undefined`. It commonly
surfaces friction in third-party types, which is why it stays opt-in.

## 9. Classes and TypeScript

Classes here are JavaScript classes plus access modifiers and interface checking. As everywhere
else, the modifiers are erased.

```ts
class Entity {
  readonly id: string;           // public by default; cannot be reassigned
  protected createdAt: Date;     // this class and subclasses
  private notes: string[] = [];  // only this class

  constructor(id: string) {
    this.id = id;
    this.createdAt = new Date();
  }

  addNote(note: string): void {
    this.notes.push(note);
  }
}
```

- `public` (the default) — anyone. `protected` — this class and subclasses. `private` — only the
  declaring class. `readonly` — assignable in the constructor or at declaration, then frozen to
  writes.

`strict` includes `strictPropertyInitialization`, so every declared field must be definitely
assigned by the end of the constructor:

```ts
class Bad {
  name: string;
  // error: Property 'name' has no initializer and is not definitely assigned in the constructor.
}
```

Fix it by initializing, by assigning in the constructor, or — last resort — with the definite
assignment assertion `name!: string`, which is the same kind of unchecked promise as `!` in Section
10. `noImplicitOverride` also requires you to mark overrides with the `override` keyword, which is
documentation that survives refactoring: rename the base method and the error points at the override
instead of leaving an orphaned method behind.

### `implements` for interfaces

`implements` checks that a class satisfies an interface. It inherits nothing, so `class FileRecord
implements Timestamped` must declare every member `Timestamped` requires — `createdAt: Date` here —
and omitting one puts the error on the class declaration. Multiple interfaces are allowed.

```ts
interface Timestamped {
  createdAt: Date;
}
```

Note that `implements` only sees *public* members — an interface describes the outside view, so a
`private` member cannot satisfy one.

### Warning: `private` is a compile-time fiction

TypeScript's `private` and `protected` are checked and then **deleted from the output**. The
property is an ordinary, visible JavaScript property at runtime.

```ts
const entity = new Entity("1");

entity.notes;
// error: Property 'notes' is private and only accessible within class 'Entity'.

(entity as any).notes;   // compiles fine
```

That assertion is not the only way in — plain JavaScript, `JSON.stringify`, and a debugger all see
the property immediately. Nothing at runtime enforces `private`. JavaScript's `#` fields are
genuinely private at runtime:

```ts
class Vault {
  #combination = "1234";
  reveal(): string { return this.#combination; }
}

const vault = new Vault();
vault.#combination;
// error: Property '#combination' is not accessible outside class 'Vault'
// because it has a private identifier. (Also a runtime SyntaxError.)
```

Use `private` for intent and compile-time checking; use `#` when privacy must actually hold. `#`
fields are standard JavaScript, so they are fully erasable and allowed under `erasableSyntaxOnly` —
and `readonly #x` is valid TypeScript. `readonly` is compile-time only for the same reason: it stops
*you* writing `entity.id = "2"`, but does not make the property immutable at runtime.

## 10. Type assertions (`as`) and non-null assertion (`!`)

Both tell the compiler "trust me." Neither does anything at runtime, because both are erased.

```ts
const raw: unknown = JSON.parse(body);

const user = raw as ApiUser;   // "believe me, this is an ApiUser"
const first = names[0]!;       // "believe me, this is not undefined"
```

`raw as ApiUser` compiles to `raw`. No check, no conversion, no validation. `as` is not a cast in
the C or Java sense; it cannot change a value. If you are wrong, the mistake surfaces later as an
unrelated runtime `TypeError`.

```ts
interface ApiUser {
  id: string;
  name: string;
}

const user = {} as ApiUser;
user.name.toUpperCase();
// compiles cleanly, then: TypeError: Cannot read properties of undefined
```

`{}` is assignable to `ApiUser`'s shape only in the permissive assertion direction, so the compiler
allows it. Every guarantee `ApiUser` offered is now a lie. `!` behaves the same way: `names[0]!`
removes `undefined` from the type without removing the possibility.

Assertions are legitimate for `as const` (unrelated, and always fine — it keeps literal types and
`readonly` instead of widening), for a guard-then-assertion pair at a single boundary where a
validator cannot express the type, and for rare cases like `Map.get` after `Map.has` where you
genuinely know more than the checker. They are a footgun because they are *silent* and *sticky*: one
at a boundary erases the doubt for every line that follows, including lines written a year later by
someone who never saw the input. Prefer a runtime guard, because it is the same amount of work and it
actually checks:

```ts
// instead of: const user = raw as ApiUser;
function parseUser(body: string): ApiUser {
  const value: unknown = JSON.parse(body);
  if (!isApiUser(value)) {
    throw new Error("Invalid user payload");
  }
  return value;   // narrowed by the guard; no assertion anywhere
}
```

The guard is the assertion, expressed as code that runs. One related tool: `satisfies` checks a
value against a type *without* widening it, which is often what people reach for `as` to do.

```ts
const defaults = { host: "localhost", port: 3000 } satisfies { host: string; port: number };
defaults.port;   // 3000 — the literal type is preserved

const annotated: { host: string; port: number } = { host: "localhost", port: 3000 };
annotated.port;  // number — the annotation widened it
```

## 11. Type-only imports and exports

In a bundler project you write imports casually and the bundler decides what to erase. There is no
bundler here, so intent must be explicit. That is what `verbatimModuleSyntax` enforces.

```ts
import type { ApiUser } from "./types.ts";                   // used only as a type
import { type ApiUser, isApiUser } from "./validators.ts";   // mixed, marked inline
export type { ApiUser };                                     // re-exporting a type
```

`import type` promises the binding is used *only* in type positions, so the whole statement can be
deleted at runtime. Consider what happens without it:

```ts
// src/validators.ts
export interface ApiUser { id: string; name: string }
```

```ts
// src/consumer.ts — WRONG
import { ApiUser } from "./validators.ts";

const user: ApiUser = { id: "1", name: "ada" };
```

The compiler is happy. Node is not:

```text
SyntaxError: The requested module './validators.ts' does not provide an export named 'ApiUser'
```

This is the crucial asymmetry. Node erases type *annotations*, but an `import` statement is real
code, and `import { ApiUser }` asks the module system for a runtime binding named `ApiUser`. The
module erases to JavaScript that exports nothing. The import fails at load time, before a single line
runs. The inline modifier fixes it, and this version runs and prints `ada`:

```ts
import { type ApiUser, isApiUser } from "./validators.ts";

const user: ApiUser = { id: "1", name: "ada" };

if (isApiUser(user)) {
  console.log(user.name);
}
```

`verbatimModuleSyntax` makes the mistake impossible to commit quietly:

```text
src/consumer.ts:1:10 - error TS1484: 'ApiUser' is a type and must be imported using a
type-only import when 'verbatimModuleSyntax' is enabled.
```

**The practical rule:** if the name is an `interface`, a `type` alias, or a type parameter, use
`import type`. If it is a function, class, or `const`, use a normal import. When unsure, hover it in
your editor, or run `npm run typecheck` and let it tell you. Re-exporting a type needs `export type`
for the same reason.

## 12. `erasableSyntaxOnly`: the no-code-generation rule

This flag keeps Node's type stripping honest. The rule: **allow only syntax that can be deleted
without generating new code.** Node is a stripper, not a compiler. It can remove annotations; it
cannot invent statements that were never in the file. `erasableSyntaxOnly` rejects the four features
that require invention, so anything `tsc` accepts is guaranteed to run under Node.

Verified against Node 24 — each fails at startup, before your code runs:

```text
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript namespace declaration is not supported in strip-only mode
SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Expected 'from', got '='
```

| Not this (needs code generation) | Do this instead (erasable) |
| --- | --- |
| `enum Status { Active = "active" }` | `const Status = { Active: "active" } as const;` plus a union type |
| `namespace Api { export const v = 1; }` | One ES module per concern: `import { v } from "./api.ts"` |
| `constructor(private repo: Repo) {}` | Declare the field, then `this.repo = repo;` |
| `import fs = require("node:fs")` | `import * as fs from "node:fs"` |
| `export = something` | `export default something` or a named export |

### `enum` -> a `const` object plus a union type

An `enum` is not an annotation; it is a runtime object TypeScript must fabricate. There is nothing to
delete, so a stripper cannot do it.

```ts
// not that
enum LogLevel {
  Debug = "debug",
  Info = "info",
  Error = "error",
}

// do this
const LogLevel = {
  Debug: "debug",
  Info: "info",
  Error: "error",
} as const;

type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];
// "debug" | "info" | "error"
```

Read the type line inside out: `typeof LogLevel` is the object's type, `keyof typeof LogLevel` is
`"Debug" | "Info" | "Error"`, and indexing the object type by those keys gives the value types.
`as const` is what keeps them literal instead of widening to `string`. You now have both things an
enum gave you, and the union is better because it works with discriminated unions and exhaustive
`switch`. For untrusted input, add the guard an enum gave you for free:

```ts
function label(level: LogLevel): string {
  switch (level) {
    case "debug": return "DEBUG";
    case "info": return "INFO";
    case "error": return "ERROR";
  }
}

const logLevels: readonly string[] = Object.values(LogLevel);

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && logLevels.includes(value);
}
```

### `namespace` -> separate modules

A `namespace` compiles to an immediately-invoked function that builds an object — generated code
again. In an ESM project it is redundant: a file *is* a module, and `import` wires things together.
So `namespace Validation { export function isEmail(...) {...} }` becomes an ordinary
`src/validation.ts` exporting `isEmail`, consumed as `import { isEmail } from "./validation.ts"`.

The one namespace form that survives is `declare namespace`, a *type-level* description of something
that already exists. It generates nothing and is erasable; you will see it in `.d.ts` files for older
libraries.

### Parameter properties -> explicit assignment

The shorthand that declares and assigns a field at once is code generation in disguise — TypeScript
writes `this.repo = repo;` into the constructor for you.

```ts
// not that
class UserService {
  constructor(private readonly repo: Repository<User>) {}
}

// do this
class UserService {
  private readonly repo: Repository<User>;

  constructor(repo: Repository<User>) {
    this.repo = repo;
  }
}
```

Three extra lines, no hidden generation, identical modifier semantics. For privacy at runtime as
well, use `#`: declare `readonly #repo: Repository<User>;` and assign `this.#repo = repo;`.

### `import =` -> ES module syntax

`import fs = require("node:fs")` and `export =` are TypeScript's CommonJS-flavored module syntax.
They are not valid ESM and there is nothing to strip — the parser rejects the `=` outright, which is
why Node's error is a plain syntax error. Use `import * as fs from "node:fs"` and `export default`.

Node can also *transform* TypeScript instead of stripping it, with `--experimental-transform-types`,
which would make `enum` and parameter properties work. This project deliberately does not use it: it
is experimental, and it would mean Node performing code generation that `tsc` also performs, so the
two outputs could drift. Keeping `erasableSyntaxOnly` on means the source you run and the source you
compile are the same program.

## 13. Types from libraries and from Node

Types for third-party code come from packages that ship declarations, or from the `@types/*`
packages published by DefinitelyTyped. `@types/node` supplies the types for Node's built-ins:

```json
"devDependencies": {
  "@types/node": "^24.0.0",
  "typescript": "^5.9.0"
}
```

Without it, importing a built-in fails to typecheck even though it runs perfectly:

```ts
import { createServer } from "node:http";
// error: Cannot find module 'node:http' or its corresponding type declarations.
```

The `^24.0.0` tracks the Node major version, which is why it version-matches `engines`. It also
supplies the globals — `process`, `Buffer`, `console` — and namespace types like `NodeJS.ProcessEnv`
from Section 5. `tsconfig.json` pins which global type packages load with `"types": ["node"]`,
meaning "include only `@types/node` automatically." Without that list, every `@types/*` package in
`node_modules` would be pulled into global scope, which can produce surprising conflicts.

### Runtime dependencies vs type-only dev dependencies

| | `dependencies` | `devDependencies` |
| --- | --- | --- |
| Installed with `npm ci --omit=dev` | Yes | No |
| Exists at runtime | Yes | No |
| Examples here | (none yet) | `typescript`, `@types/node` |

`typescript` and `@types/node` are `devDependencies` because **nothing in them runs when the program
runs.** `typescript` is a binary you invoke; `@types/node` contains only `.d.ts` declaration files,
consumed by the checker and then gone. A production install that omits dev dependencies still runs
the API. A package belongs in `dependencies` when `npm start` needs its code present. The narrower
consequence here: the *types* are never needed at runtime, but `npm run build` needs `typescript`, so
a build must happen where dev dependencies are installed. Many libraries ship their own declarations
(a `"types"` field, or a bundled `.d.ts`) and need no `@types` package. Finally,
`"skipLibCheck": true` stops the checker from typechecking dependencies' `.d.ts` files, which speeds
up checking and prevents an unrelated conflict inside a dependency's declarations from breaking your
build, without weakening checking of *your* code.

## 14. `.ts` extension imports and module resolution

If you come from a bundler project, this is the most jarring thing in the file. Bundlers resolve
extensionless specifiers. This project uses `"type": "module"` in `package.json`, which means Node's
real ES module resolver — and **that resolver requires an explicit file extension.** There is no
bundler to guess, so the specifier must name the file that exists on disk, and the file on disk is
`router.ts`:

```ts
import { route } from "./router.ts";
import type { User } from "../types.ts";
```

| Bundler habit | What this project writes |
| --- | --- |
| `from "./router"` | `from "./router.ts"` |
| `from "../lib/util"` | `from "../lib/util.ts"` |
| `from "./types"` (a type) | `import type { User } from "./types.ts"` |

Get it wrong and Node says so plainly — note the missing extension in the message, because in ESM
nothing is implied:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\...\src\router'
imported from C:\...\src\server.ts
```

### Why `.ts` and not `.js`

The instinct is to write `./router.js`, because that is what the file is *at runtime*. That was the
older workaround, and it is confusing because the file you are looking at is `router.ts`. This
project writes the path to the source file and lets the compiler translate it when building:

```jsonc
"allowImportingTsExtensions": true,      // let me write './router.ts' in the source
"rewriteRelativeImportExtensions": true, // and rewrite it to './router.js' when I emit
```

```ts
// src/server.ts
import { route } from "./router.ts";
import type { User } from "./types.ts";
import { createServer } from "node:http";
```

After `npm run build`, `dist/server.js` contains `import { route } from "./router.js";` and
`import { createServer } from "node:http";`. The relative specifier was rewritten from `.ts` to
`.js`, the type-only import was deleted, and the bare `node:http` specifier was untouched — the
rewrite applies only to relative paths. `dist/router.js` exists because `rootDir` is `src` and
`outDir` is `dist`, preserving the layout.

**Practical advice:** write the extension on every relative import, always: `.ts`, not `.js`, not
nothing. Let your editor complete the path, since it inserts the extension when it knows the setting.
Do not work around the rule with extensionless imports "just for now" — they fail at runtime with
`ERR_MODULE_NOT_FOUND`, and the message is easy to misread. Prefer static `import` statements; a
dynamic `import()` with a computed path cannot be rewritten by the compiler.

## 15. The practical workflow

| Script | Command | What it does |
| --- | --- | --- |
| `npm run dev` | `node --watch --env-file-if-exists=.env src/server.ts` | Runs the `.ts` source directly, restarting on change |
| `npm run typecheck` | `tsc -p tsconfig.json` | Checks types; writes no files (`noEmit: true`) |
| `npm run build` | `tsc -p tsconfig.build.json` | Emits plain JavaScript into `dist/` |
| `npm start` | `node --env-file-if-exists=.env dist/server.js` | Runs the compiled output in `dist/` |
| `npm test` | `node --test ... "tests/**/*.test.ts"` | Runs Node's built-in test runner on the `.ts` tests |
| `npm run clean` | `node --eval "..."` | Deletes `dist/` |

Note the shape of the first four: `dev` and `test` run `.ts` files, `start` runs a `.js` file, and
the two `tsc` scripts differ only in which config they use. That is Section 2's two jobs, expressed
as npm scripts. `--env-file-if-exists=.env` loads `.env` when present and stays quiet when it is
missing, so a fresh clone runs without setup.

**While writing code, use `npm run dev`.** Node strips the types and runs your source, and `--watch`
restarts on save. No build step, no watcher configuration, no dependency — this is why the project
has no bundler.

**The catch, and it matters: `npm run dev` does no type checking at all.** Node cannot report a type
error, because by the time Node has the code the types are gone. A file full of type errors starts up
and serves requests as if nothing were wrong. Your editor is probably checking in the background and
drawing squiggles, but the running process is not.

**So also run `npm run typecheck`.** This is the checker, and the only thing in the workflow that
ever tells you your types are wrong. Run it in a second terminal alongside `npm run dev`, or before
you commit. Read its exit code, not its output — `tsc` prints nothing at all when the code is clean.

**When you want JavaScript output, use `npm run build`.** This is the only script using
`tsconfig.build.json`, which extends the base config and flips `noEmit` to `false` with
`outDir: dist` and `rootDir: src`. It narrows `include` to `src/**/*.ts` and excludes `*.test.ts`, so
tests are not built into `dist/`. You need it when the target environment cannot strip types or when
you want to ship output without the source. You do not need it to develop.

One behavior to be aware of: **`tsc` writes output even when there are type errors**, because
`noEmitOnError` defaults to `false`. So a failing `npm run build` prints errors and exits non-zero,
but may still leave a `dist/` behind. If you want a build that refuses to write anything unless the
types are clean, add `"noEmitOnError": true` to `tsconfig.build.json`. Either way, treat a non-zero
exit as a failure and do not deploy the output. To run what was built, use
`npm run build && npm start`; `npm run clean` removes `dist/`.

| You want to | Run |
| --- | --- |
| Iterate on behavior | `npm run dev` |
| Know whether the types are right | `npm run typecheck` |
| Produce JavaScript in `dist/` | `npm run build` |
| Run the built JavaScript | `npm run build && npm start` |

## 16. Appendix: the tsconfig, flag by flag

`tsconfig.json` is the base config used by your editor and `npm run typecheck`.
`tsconfig.build.json` extends it and turns emission on. Both contain comments, which TypeScript
allows because it reads `tsconfig.json` as JSON with comments.

```jsonc
// tsconfig.build.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,     // the base config sets this to true
    "outDir": "dist",    // where compiled JavaScript goes
    "rootDir": "src",    // so dist/ mirrors src/ instead of nesting it
    "declaration": false
  },
  "include": ["src/**/*.ts"],       // tests are not built
  "exclude": ["src/**/*.test.ts"]
}
```

| Flag | Setting | Meaning |
| --- | --- | --- |
| `target` / `lib` | `es2024` | The runtime is a known, modern Node, so the compiler never downlevels and the type definitions match the API surface that exists. There is no `"dom"`, so browser globals correctly do not exist. |
| `module` / `moduleResolution` | `nodenext` | Follow Node's real ESM rules: `"type": "module"` respected, explicit extensions required. |
| `types` | `["node"]` | Load only `@types/node` into global scope. |
| `strict` | `true` | The strictness bundle (Section 8). |
| `noUncheckedIndexedAccess` | `true` | `arr[0]` and `record["k"]` become possibly `undefined`. |
| `noImplicitOverride` | `true` | Subclass overrides need `override`. |
| `noImplicitReturns` | `true` | Every code path must return a value where one is expected. |
| `noFallthroughCasesInSwitch` | `true` | A non-empty `case` may not fall through. |
| `allowUnreachableCode` | `false` | Dead code after `return`/`throw` is an error. |
| `verbatimModuleSyntax` | `true` | Type-only imports must say so (Section 11). |
| `erasableSyntaxOnly` | `true` | No syntax requiring code generation (Section 12). |
| `allowImportingTsExtensions` | `true` | `from "./router.ts"` is allowed. |
| `rewriteRelativeImportExtensions` | `true` | ...and becomes `"./router.js"` on emit. |
| `isolatedModules` | `true` | Every file must compile alone, which is how Node loads them; `erasableSyntaxOnly` is the stricter version of the same guarantee. |
| `noEmit` | `true` | Check only; write no files. Node runs the `.ts` source. |
| `sourceMap` | `true` | Emit `.js.map` files so stack traces can point at `.ts`. |
| `skipLibCheck` | `true` | Do not typecheck dependencies' declarations. |
| `forceConsistentCasingInFileNames` | `true` | `./Router.ts` and `./router.ts` are not the same import. |

The `noImplicitReturns`, `noFallthroughCasesInSwitch`, and `allowUnreachableCode: false` trio catch
control-flow mistakes JavaScript accepts silently, and pair naturally with the discriminated unions
in Section 4. `exactOptionalPropertyTypes` is absent because the project does not enable it; see
Section 8. Four settings define this project's character: **`noEmit`** (TypeScript here is a checker,
not a build tool — Node runs the `.ts` files), **`erasableSyntaxOnly`** (every line must survive
deletion), **`verbatimModuleSyntax`** (type-only imports are explicit, because a wrong guess is a
runtime crash), and **`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`** (the source
says `.ts`, the build rewrites it to `.js`).
