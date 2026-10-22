/**
 * The data store.
 *
 * This is the only file in the project that knows how tasks are kept. Everything
 * else asks this class. That separation -- handlers deal with HTTP, the store
 * deals with data -- is what makes it possible to swap the in-memory `Map` for a
 * real database later without touching a single route handler.
 *
 * The pattern has a name: the **repository pattern**. The value of it is not
 * ceremony, it is that the HTTP layer never learns whether the data lives in
 * memory, in Postgres or behind an HTTP call to another service.
 *
 * ## The big caveat
 *
 * This store keeps everything in a `Map`, which means:
 *   - **Everything is lost when the process exits.** Restart the server and you
 *     are back to the seeded tasks.
 *   - **Every process has its own copy.** Run two instances of the server and
 *     they will disagree about what tasks exist.
 *   - **Nothing is shared or transactional.** Concurrent writes are fine here
 *     only because Node runs your JavaScript on a single thread.
 *
 * That is entirely fine for learning, and it also means you can experiment
 * freely -- there is no database to reset. Making it durable is the natural next
 * step; see docs/08-next-steps.md.
 */

import { randomUUID } from 'node:crypto';
import type {
  Task,
  TaskListQuery,
  TaskUpdateInput,
  TaskWriteInput,
} from '../types/task.ts';

/**
 * What `list` returns.
 *
 * `items` is the page the client asked for; `total` is how many tasks matched
 * *before* pagination was applied. Keeping both means the client can render
 * "showing 20 of 137" without a second request.
 */
export interface TaskListResult {
  readonly items: readonly Task[];
  readonly total: number;
}

/**
 * The in-memory task store.
 */
export class TaskStore {
  /**
   * The tasks, keyed by id.
   *
   * `#tasks` uses JavaScript's own private-field syntax. As noted in
   * `router.ts`, this differs from TypeScript's `private` keyword: `#` fields are
   * enforced by the JavaScript engine and genuinely unreachable from outside,
   * whereas `private` is erased along with the rest of the types and offers no
   * runtime protection at all.
   *
   * A `Map` is a better fit than a plain object here. Ids are `randomUUID()`
   * values, which look like
   * `'3f2504e0-4f89-11d3-9a0c-0305e82c3301'` -- always safe as keys, but a `Map`
   * avoids the whole question of prototype keys (`obj['constructor']` is a real
   * footgun), has a real `.size`, and preserves insertion order.
   */
  readonly #tasks = new Map<string, Task>();

  /**
   * Fill the store with initial tasks.
   *
   * Intended for local development and tests, so the API has something to show
   * before you have created anything. Note that it uses `create`, so seeded tasks
   * go through exactly the same code path as tasks created over HTTP -- there is
   * no second, subtly different way to make a task.
   */
  seed(entries: readonly TaskWriteInput[]): void {
    for (const entry of entries) {
      this.create(entry);
    }
  }

  /**
   * Return one page of tasks, plus the total number that matched.
   *
   * The filters are applied first, then the page is cut out with `slice`. The
   * ordering that falls out of this is insertion order, because that is what a
   * `Map` iterates in. It is predictable and stable, which matters more here than
   * being interesting. A production API would almost certainly accept a `?sort=`
   * parameter; see docs/08-next-steps.md.
   */
  list(query: TaskListQuery): TaskListResult {
    const matching = [...this.#tasks.values()].filter(
      (task) =>
        // An absent filter means "no opinion", which is different from
        // `?completed=false` meaning "only the unfinished ones". Comparing
        // against `undefined` explicitly is what keeps those two cases distinct.
        (query.completed === undefined || task.completed === query.completed) &&
        (query.priority === undefined || task.priority === query.priority),
    );

    // `slice` handles both ends gracefully: an offset past the end returns an
    // empty array rather than throwing, and a limit longer than the remaining
    // items simply returns what is left.
    const items = matching.slice(query.offset, query.offset + query.limit);

    return { items, total: matching.length };
  }

  /** Find one task by its id, or `undefined` if there is no such task. */
  findById(id: string): Task | undefined {
    return this.#tasks.get(id);
  }

  /** How many tasks exist in total. */
  count(): number {
    return this.#tasks.size;
  }

  /**
   * Create a task and return it.
   *
   * `randomUUID` comes from Node's built-in `node:crypto`. Ids are generated on
   * the server rather than by the client, which is the usual arrangement: the
   * server owns the identity of its resources, and a client cannot claim an id
   * that is already taken.
   *
   * Note the timestamps. Both are set to the same value on creation, and they
   * only diverge once the task is updated. Having both means a client can tell
   * "this was created a while ago" from "this was changed recently" -- and
   * `updatedAt` is what makes caching and sync possible later.
   *
   * `new Date().toISOString()` produces a UTC timestamp like
   * `'2024-05-01T12:34:56.789Z'`. The trailing `Z` is the important part: store
   * and transmit timestamps in UTC, and convert to a local time zone only when
   * displaying them.
   */
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

  /**
   * Replace a task wholesale, or return `undefined` if it does not exist.
   *
   * This is the operation behind `PUT`. Note that `id` and `createdAt` are
   * carried over from the existing task -- they identify the resource rather than
   * describe its contents, so a replace must not disturb them.
   *
   * "Return `undefined` to signal not found" is a deliberate style. The
   * alternative is throwing `NotFoundError` from here, which would drag HTTP
   * concerns into the data layer. The handler knows the request context; the
   * store does not, and should not.
   */
  replace(id: string, input: TaskWriteInput): Task | undefined {
    const existing = this.#tasks.get(id);
    if (existing === undefined) {
      return undefined;
    }

    const replaced: Task = {
      id: existing.id,
      createdAt: existing.createdAt,
      title: input.title,
      description: input.description,
      priority: input.priority,
      completed: input.completed,
      updatedAt: new Date().toISOString(),
    };

    this.#tasks.set(id, replaced);
    return replaced;
  }

  /**
   * Apply a partial update, or return `undefined` if the task does not exist.
   *
   * This is the operation behind `PATCH`. Each field falls back to the existing
   * value when the patch does not mention it.
   *
   * `description` needs its own line because `??` would be wrong there. A patch
   * of `{"description": null}` is a deliberate request to *clear* the
   * description, and `null ?? existing.description` would treat that `null` as
   * "nothing to do" and keep the old text. Only `undefined` -- meaning the field
   * was absent -- should preserve the existing value, so the check has to be
   * explicit.
   */
  update(id: string, patch: TaskUpdateInput): Task | undefined {
    const existing = this.#tasks.get(id);
    if (existing === undefined) {
      return undefined;
    }

    const updated: Task = {
      id: existing.id,
      createdAt: existing.createdAt,
      // For the other fields `??` is correct: `undefined` (absent) falls back to
      // the existing value, and every real value passes through untouched.
      title: patch.title ?? existing.title,
      description:
        patch.description === undefined ? existing.description : patch.description,
      priority: patch.priority ?? existing.priority,
      completed: patch.completed ?? existing.completed,
      updatedAt: new Date().toISOString(),
    };

    this.#tasks.set(id, updated);
    return updated;
  }

  /**
   * Delete a task.
   *
   * Returns whether anything was actually removed, which is exactly what the
   * handler needs to decide between `204 No Content` and `404 Not Found`.
   * `Map.delete` returning a boolean saves us a separate existence check, and the
   * check-then-delete version would be a race in a concurrent setting anyway.
   */
  delete(id: string): boolean {
    return this.#tasks.delete(id);
  }

  /**
   * Remove every task.
   *
   * Not exposed over HTTP. It exists for tests, which need a clean slate, and it
   * is a reminder that "the store is the only thing that touches the data" cuts
   * both ways: it is also the only thing that *should* be able to wipe it.
   */
  clear(): void {
    this.#tasks.clear();
  }
}
