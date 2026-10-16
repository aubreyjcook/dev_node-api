/**
 * The task domain types.
 *
 * Everything in this file is *type-level only* except for `TASK_PRIORITIES`,
 * which is a real array that exists at runtime. Node keeps the array and throws
 * away every `interface` and `type` when it strips the types out of this file.
 */

/**
 * The allowed priorities.
 *
 * `as const` is doing two jobs here:
 *   1. It stops the array from being widened to `string[]`, so it stays a tuple
 *      of the three exact string literals.
 *   2. It makes the array `readonly`, so nobody can `push` onto it by accident.
 *
 * This is the idiomatic TypeScript replacement for an `enum`. See the note in
 * docs/02-typescript-for-javascript-developers.md about why we avoid `enum`
 * (short version: Node's type stripper cannot erase it, and `erasableSyntaxOnly`
 * in our tsconfig forbids it).
 */
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;

/**
 * `(typeof TASK_PRIORITIES)[number]` reads as "the type of one element of the
 * TASK_PRIORITIES array", which is the union `'low' | 'medium' | 'high'`.
 *
 * Defining the type *from* the runtime value like this means the two can never
 * drift apart. Add a priority to the array and the type updates automatically.
 */
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * A task as the API represents it and returns it.
 *
 * `readonly` on every field is a compile-time promise that our own code will not
 * reassign them. It costs nothing at runtime, and it nudges us toward building a
 * new object instead of mutating one in place -- which is much easier to reason
 * about, especially once several requests are in flight at the same time.
 *
 * Note that `createdAt`/`updatedAt` are `string`, not `Date`. JSON has no date
 * type, so timestamps travel as ISO 8601 strings. Keeping the domain type as a
 * string avoids a confusing round trip where a `Date` silently becomes a string
 * as soon as it is serialized.
 */
export interface Task {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly priority: TaskPriority;
  readonly completed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The shape of a request body for a *full write*: `POST /api/tasks` and
 * `PUT /api/tasks/:id`.
 *
 * Every field is required here even though most are optional in the JSON that
 * the client sends. That is deliberate: validation is the boundary where we
 * normalise messy external input into a complete, predictable internal shape.
 * Past that boundary, handlers and the store never have to ask "what if
 * `priority` is missing?" -- it cannot be.
 *
 * `description` is `string | null` rather than optional. `null` is the explicit
 * "there is no description" value, which is meaningfully different from "the
 * field was absent from the request".
 */
export interface TaskWriteInput {
  readonly title: string;
  readonly description: string | null;
  readonly priority: TaskPriority;
  readonly completed: boolean;
}

/**
 * The shape of a request body for a *partial update*: `PATCH /api/tasks/:id`.
 *
 * Every field is optional, and the `?` means the property may be missing
 * entirely. The store treats a missing property as "leave this field alone".
 */
export interface TaskUpdateInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly priority?: TaskPriority;
  readonly completed?: boolean;
}

/**
 * A validated set of options for `GET /api/tasks`.
 *
 * The query string is all text, so the validator's job is to turn
 * `?completed=true&limit=20` into typed, checked values like these.
 */
export interface TaskListQuery {
  readonly completed?: boolean;
  readonly priority?: TaskPriority;
  readonly limit: number;
  readonly offset: number;
}
