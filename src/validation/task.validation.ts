/**
 * Runtime validation of request data.
 *
 * **This file is not about types. It is about trust.**
 *
 * TypeScript's types exist only while you are writing code. They are erased
 * before the program runs, so an `interface` cannot check anything at runtime.
 * A client can POST whatever it likes -- a number where a string belongs, a
 * 5 MB nested array, a field you have never heard of -- and from the type
 * checker's point of view that data is whatever your interface says it is.
 *
 * So every byte that comes in from outside must be *validated*, not merely
 * *typed*. That is what this file does: it takes `unknown` and either returns a
 * trustworthy value or throws a 422 explaining exactly what is wrong.
 *
 * The general shape of every function here is the same:
 *   1. Prove the input is a JSON object.
 *   2. Walk each field, collecting problems instead of throwing at the first one.
 *   3. If anything was wrong, throw once with the complete list.
 *   4. Otherwise return a freshly built, fully populated value.
 *
 * Collecting all the problems (step 2) rather than stopping at the first is a
 * deliberate choice. It means a client with three mistakes gets told about all
 * three at once instead of playing whack-a-mole one request at a time.
 */

import {
  BadRequestError,
  UnprocessableEntityError,
} from '../http/errors.ts';
import {
  TASK_PRIORITIES,
  type TaskListQuery,
  type TaskPriority,
  type TaskUpdateInput,
  type TaskWriteInput,
} from '../types/task.ts';

/** Maximum accepted length of a task title, in characters. */
export const MAX_TITLE_LENGTH = 200;

/** Maximum accepted length of a task description, in characters. */
export const MAX_DESCRIPTION_LENGTH = 2000;

/** Priority applied when a write request omits one. */
export const DEFAULT_PRIORITY: TaskPriority = 'medium';

/** Default number of tasks returned by `GET /api/tasks` when `limit` is absent. */
export const DEFAULT_PAGE_LIMIT = 20;

/** Largest value accepted for the `limit` query parameter. */
export const MAX_PAGE_LIMIT = 100;

/**
 * One validation problem, addressed to a specific field.
 *
 * The `field` name is part of the API contract. It is what lets a client put the
 * error message next to the right input box in a form, so it should match the
 * JSON property name exactly.
 */
export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

/**
 * The property names a write request may contain.
 *
 * Used to reject unknown properties. Being strict here is a choice, and a
 * defensible one: it means a typo like `{"titel": "..."}` produces a clear error
 * instead of a task created with a default title and the client's data silently
 * discarded.
 *
 * The alternative -- ignoring unknown fields -- is more forgiving and better for
 * forward compatibility when clients are updated before servers. Pick one and be
 * consistent about it.
 */
const WRITE_FIELDS = ['title', 'description', 'priority', 'completed'] as const;

/** The query parameters `GET /api/tasks` understands. */
const LIST_QUERY_FIELDS = ['completed', 'priority', 'limit', 'offset'] as const;

/**
 * Gathers issues as validation proceeds.
 *
 * This is a small, focused class rather than a plain array because it keeps the
 * readers below tidy: each one calls `collector.add(...)` and returns, instead of
 * every function having to thread an array parameter around and remember to
 * check whether it is still valid.
 */
class FieldCollector {
  readonly issues: FieldIssue[] = [];

  /** Record a problem with a field. */
  add(field: string, message: string): void {
    this.issues.push({ field, message });
  }

  /**
   * `true` while no problems have been recorded.
   *
   * Declared as a getter (a property computed on access) so callers write
   * `collector.ok` rather than `collector.ok()`. Getters let a method masquerade
   * as a property, which reads better when the computation is trivial.
   */
  get ok(): boolean {
    return this.issues.length === 0;
  }
}

/**
 * A generic type guard: is `value` one of these exact strings?
 *
 * Two TypeScript features meet here.
 *
 * `T extends string` is a *generic constraint* -- it says T can be any type, as
 * long as it is assignable to `string`. Without it, `candidate === value` would
 * be a type error, because comparing two unrelated types is almost always a bug.
 *
 * The return type `value is T` is a *type predicate*. It is a promise to the
 * compiler: "if this function returns true, then in the calling code you may
 * narrow `value` to type `T`." The compiler cannot verify that promise -- it
 * takes your word for it -- so a wrong predicate silently produces unsound code.
 * That is the price of being able to teach the compiler about your own runtime
 * checks.
 */
function isOneOf<T extends string>(candidates: readonly T[], value: string): value is T {
  return candidates.some((candidate) => candidate === value);
}

/** Narrow an arbitrary value to a known task priority. */
function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && isOneOf(TASK_PRIORITIES, value);
}

/**
 * Prove that a parsed JSON body is a plain object.
 *
 * The three checks are all necessary:
 *   - `typeof value !== 'object'` rejects strings, numbers, booleans and
 *     `undefined`. (It is easy to forget that `JSON.parse('"hello"')` succeeds
 *     and returns a string -- valid JSON is not necessarily an object.)
 *   - `value === null` is required because `typeof null === 'object'`, one of
 *     JavaScript's most famous historical quirks.
 *   - `Array.isArray` rejects arrays, which are objects and would otherwise
 *     pass. `JSON.parse('[1,2,3]')` is valid JSON too.
 *
 * The cast at the end is the "validate, then assert" pattern. We have just
 * proved at runtime that this value is a non-null, non-array object, so telling
 * the compiler it is a `Record<string, unknown>` is honest -- unlike a bare `as`
 * with no check behind it, which is just wishing.
 */
function requireJsonObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new UnprocessableEntityError('The request body must be a JSON object.', [
      {
        field: '(body)',
        message: 'Expected a JSON object such as {"title": "Buy milk"}, not a string, number, array or null.',
      },
    ]);
  }
  return body as Record<string, unknown>;
}

/** Reject any property we do not recognise. */
function rejectUnknownFields(raw: Record<string, unknown>, collector: FieldCollector): void {
  for (const key of Object.keys(raw)) {
    if (!isOneOf(WRITE_FIELDS, key)) {
      collector.add(key, `Unknown field. This endpoint accepts: ${WRITE_FIELDS.join(', ')}.`);
    }
  }
}

/**
 * Read and check the `title` field.
 *
 * `required` distinguishes the two calling contexts. A full write (`POST`, `PUT`)
 * must include a title, so its absence is a problem. A partial update (`PATCH`)
 * may omit it, in which case absence is perfectly fine and means "leave it".
 *
 * Returning the trimmed string is a small act of normalisation. Storing
 * `"  Buy milk  "` and storing `"Buy milk"` as different values would surprise
 * everyone, so we decide once, here, that titles are trimmed.
 */
function readTitle(
  raw: Record<string, unknown>,
  collector: FieldCollector,
  required: boolean,
): string | undefined {
  const value = raw['title'];

  if (value === undefined) {
    if (required) {
      collector.add('title', 'Title is required.');
    }
    return undefined;
  }

  if (typeof value !== 'string') {
    collector.add('title', 'Must be a string.');
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    collector.add('title', 'Must not be empty or whitespace only.');
    return undefined;
  }

  if (trimmed.length > MAX_TITLE_LENGTH) {
    collector.add(
      'title',
      `Must be at most ${MAX_TITLE_LENGTH} characters. Received ${trimmed.length}.`,
    );
    return undefined;
  }

  return trimmed;
}

/**
 * Read and check the `description` field.
 *
 * Note the three-way return type `string | null | undefined`:
 *   - `undefined` -> the property was not sent (leave it alone on a PATCH)
 *   - `null`      -> explicitly "no description"
 *   - `string`    -> a real description
 *
 * An empty string is normalised to `null`. There is no useful difference between
 * "a description of length zero" and "no description", and collapsing them here
 * means no consumer ever has to decide which one it is looking at.
 */
function readDescription(
  raw: Record<string, unknown>,
  collector: FieldCollector,
): string | null | undefined {
  const value = raw['description'];

  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    collector.add('description', 'Must be a string or null.');
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    collector.add(
      'description',
      `Must be at most ${MAX_DESCRIPTION_LENGTH} characters. Received ${trimmed.length}.`,
    );
    return undefined;
  }

  return trimmed;
}

/** Read and check the `priority` field against the allowed list. */
function readPriority(
  raw: Record<string, unknown>,
  collector: FieldCollector,
): TaskPriority | undefined {
  const value = raw['priority'];

  if (value === undefined) {
    return undefined;
  }

  // `isTaskPriority` both checks the value and narrows its type, so `value` is a
  // `TaskPriority` inside this branch with no cast required.
  if (isTaskPriority(value)) {
    return value;
  }

  collector.add('priority', `Must be one of: ${TASK_PRIORITIES.join(', ')}.`);
  return undefined;
}

/** Read and check the `completed` field. */
function readCompleted(
  raw: Record<string, unknown>,
  collector: FieldCollector,
): boolean | undefined {
  const value = raw['completed'];

  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }

  // Deliberately not accepting the strings "true"/"false" here. Query parameters
  // are always strings so they get parsed as such below, but a JSON body has real
  // booleans available. Accepting both in one place invites inconsistency.
  collector.add('completed', 'Must be a boolean (true or false).');
  return undefined;
}

/**
 * Validate the body of `POST /api/tasks` and `PUT /api/tasks/:id`.
 *
 * Both verbs share this parser because they share the same semantics: send the
 * complete state of the resource. The difference between them is not the shape of
 * the body but what happens to a resource that already exists -- `POST` always
 * creates a new one, `PUT` replaces the one at that URL. See
 * docs/01-http-and-rest-fundamentals.md for why PUT must be idempotent.
 *
 * The `title === undefined || !collector.ok` condition is doing double duty, and
 * that is intentional. The `!collector.ok` half asks "did anything fail?", while
 * `title === undefined` is what lets TypeScript narrow `title` from
 * `string | undefined` to plain `string` for the return statement below. Reading
 * the type checker's mind like this is normal in TypeScript; the alternative is a
 * non-null assertion `title!`, which would throw away the checking instead of
 * using it.
 *
 * Note that the two halves always agree: `readTitle` is called with
 * `required: true`, so it records an issue whenever it returns `undefined`. The
 * `collector.issues` array is therefore never empty when we throw.
 */
export function parseTaskWriteInput(body: unknown): TaskWriteInput {
  const raw = requireJsonObject(body);
  const collector = new FieldCollector();

  rejectUnknownFields(raw, collector);

  const title = readTitle(raw, collector, true);
  const description = readDescription(raw, collector);
  const priority = readPriority(raw, collector);
  const completed = readCompleted(raw, collector);

  if (title === undefined || !collector.ok) {
    throw new UnprocessableEntityError('The request body failed validation.', collector.issues);
  }

  // Every optional field now gets a concrete value. The `??` operator supplies
  // the default only when the left side is `null` or `undefined`, so a real
  // `false` for `completed` survives intact -- `||` would wrongly turn it into
  // the default. This is the classic `??` vs `||` trap.
  return {
    title,
    description: description ?? null,
    priority: priority ?? DEFAULT_PRIORITY,
    completed: completed ?? false,
  };
}

/**
 * A mutable version of `TaskUpdateInput`.
 *
 * `TaskUpdateInput` marks every property `readonly`, which is right for values
 * being passed *into* the store. But here we are assembling the object one field
 * at a time, and TypeScript will not let us assign to a readonly property -- even
 * on an object we just created ourselves.
 *
 * A local mutable type solves that cleanly, and converting between the two is
 * free because their shapes are identical. This is the honest way to handle
 * readonly: use a mutable type while building, then hand back the readonly view.
 */
interface MutableTaskUpdate {
  title?: string;
  description?: string | null;
  priority?: TaskPriority;
  completed?: boolean;
}

/**
 * Validate the body of `PATCH /api/tasks/:id`.
 *
 * The important difference from a full write: a field that is *absent* means
 * "leave this alone", while a field that is *present but invalid* is still an
 * error. So `{}` and `{"title": ""}` are both rejected, for different reasons --
 * one updates nothing, the other asks for something impossible.
 *
 * This is why the reader functions return `undefined` for "absent" rather than
 * conflating it with "invalid". They are different outcomes and the code below
 * depends on telling them apart.
 */
export function parseTaskUpdateInput(body: unknown): TaskUpdateInput {
  const raw = requireJsonObject(body);
  const collector = new FieldCollector();

  rejectUnknownFields(raw, collector);

  const title = readTitle(raw, collector, false);
  const description = readDescription(raw, collector);
  const priority = readPriority(raw, collector);
  const completed = readCompleted(raw, collector);

  if (!collector.ok) {
    throw new UnprocessableEntityError('The request body failed validation.', collector.issues);
  }

  const patch: MutableTaskUpdate = {};
  if (title !== undefined) {
    patch.title = title;
  }
  if (description !== undefined) {
    patch.description = description;
  }
  if (priority !== undefined) {
    patch.priority = priority;
  }
  if (completed !== undefined) {
    patch.completed = completed;
  }

  // A PATCH that changes nothing is almost certainly a client bug -- an empty
  // form submission, or a field that was silently misspelled. (The misspelling
  // case would already be caught above.) Refusing it gives the developer a clear
  // signal instead of a 200 that quietly did nothing.
  if (Object.keys(patch).length === 0) {
    throw new UnprocessableEntityError(
      'The request body must contain at least one field to update.',
      [{ field: '(body)', message: `Provide at least one of: ${WRITE_FIELDS.join(', ')}.` }],
    );
  }

  return patch;
}

/**
 * Read a whole-number query parameter.
 *
 * Query parameters are always strings, so `?limit=10` arrives as `'10'`. A
 * missing parameter (`null`) means "use the default". Anything else must be a
 * whole number in range.
 *
 * The explicit empty-string check matters: `Number('')` is `0`, and `0` is a
 * perfectly valid integer, so without the check a request like `?limit=` would
 * quietly mean zero rather than being reported as the mistake it is.
 */
function readIntegerQueryParam(
  searchParams: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  issues: FieldIssue[],
): number {
  const raw = searchParams.get(name);

  if (raw === null) {
    return fallback;
  }

  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  const invalid =
    trimmed.length === 0 ||
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum;

  if (invalid) {
    issues.push({
      field: name,
      message: `Must be a whole number between ${minimum} and ${maximum}. Received "${raw}".`,
    });
    return fallback;
  }

  return parsed;
}

/**
 * Validate the query string of `GET /api/tasks`.
 *
 * **Why a 400 here instead of a 422?** The 422 used above means "the JSON you
 * sent is well formed but semantically unacceptable". A query parameter is a
 * different kind of input: it is part of the URL, and a `limit` that is not a
 * number makes the URL itself malformed as a request to this endpoint. That is
 * squarely a 400. The line between the two is a convention rather than a law,
 * but drawing it consistently -- 400 for the shape of the request, 422 for the
 * content of the body -- is what makes an API predictable.
 */
export function parseTaskListQuery(searchParams: URLSearchParams): TaskListQuery {
  const issues: FieldIssue[] = [];

  // Unknown parameters are rejected, for the same reason unknown body fields are:
  // `?completd=true` silently returning everything is a nasty bug to chase.
  // A `Set` de-duplicates so `?foo=1&foo=2` is reported once.
  for (const key of new Set(searchParams.keys())) {
    if (!isOneOf(LIST_QUERY_FIELDS, key)) {
      issues.push({
        field: key,
        message: `Unknown query parameter. Supported parameters are: ${LIST_QUERY_FIELDS.join(', ')}.`,
      });
    }
  }

  const query: { completed?: boolean; priority?: TaskPriority; limit: number; offset: number } = {
    limit: DEFAULT_PAGE_LIMIT,
    offset: 0,
  };

  const completedRaw = searchParams.get('completed');
  if (completedRaw !== null) {
    if (completedRaw === 'true') {
      query.completed = true;
    } else if (completedRaw === 'false') {
      query.completed = false;
    } else {
      issues.push({ field: 'completed', message: 'Must be "true" or "false".' });
    }
  }

  const priorityRaw = searchParams.get('priority');
  if (priorityRaw !== null) {
    if (isTaskPriority(priorityRaw)) {
      query.priority = priorityRaw;
    } else {
      issues.push({
        field: 'priority',
        message: `Must be one of: ${TASK_PRIORITIES.join(', ')}.`,
      });
    }
  }

  query.limit = readIntegerQueryParam(
    searchParams,
    'limit',
    DEFAULT_PAGE_LIMIT,
    1,
    MAX_PAGE_LIMIT,
    issues,
  );
  query.offset = readIntegerQueryParam(searchParams, 'offset', 0, 0, 1_000_000, issues);

  if (issues.length > 0) {
    throw new BadRequestError('One or more query parameters are invalid.', issues);
  }

  return query;
}
