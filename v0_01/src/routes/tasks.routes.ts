/**
 * The task endpoints.
 *
 * Everything HTTP-specific lives here: which status code to use, what goes in a
 * header, when to read a body. The handler's job is to translate between HTTP and
 * the store, and it should stay thin enough that you can read all six endpoints
 * in one sitting.
 *
 * ## The endpoint table
 *
 * | Method | Path              | Success    | Purpose                          |
 * |--------|-------------------|------------|----------------------------------|
 * | GET    | `/api/tasks`      | 200        | List tasks (filter, paginate)    |
 * | POST   | `/api/tasks`      | 201        | Create a task                    |
 * | GET    | `/api/tasks/:id`  | 200        | Fetch one task                   |
 * | PUT    | `/api/tasks/:id`  | 200        | Replace a task entirely          |
 * | PATCH  | `/api/tasks/:id`  | 200        | Update some fields of a task     |
 * | DELETE | `/api/tasks/:id`  | 204        | Delete a task                    |
 *
 * ## Why the dependencies are passed in
 *
 * `registerTaskRoutes` receives the store and the body-size limit as arguments
 * rather than importing a global. This is **dependency injection**, and its
 * practical benefit is testability: a test can build an app with its own store
 * and its own limits, run it in isolation, and never worry about state leaking
 * between tests. A module-level singleton would make that impossible.
 *
 * It also makes the dependencies visible. Reading the signature tells you
 * everything this module needs in order to work, which is a property worth
 * preserving in any codebase.
 */

import { NotFoundError } from '../http/errors.ts';
import { requireParam } from '../http/context.ts';
import { readJsonBody } from '../http/request.ts';
import { sendJson, sendNoContent } from '../http/response.ts';
import {
  parseTaskListQuery,
  parseTaskUpdateInput,
  parseTaskWriteInput,
} from '../validation/task.validation.ts';
import type { TaskStore } from '../data/task.store.ts';
import type { Router } from '../router.ts';

/**
 * What this module needs to do its job.
 *
 * Bundling the dependencies into a single named object rather than taking them as
 * separate parameters means adding a dependency later does not change the
 * function's arity and break every call site.
 */
export interface TaskRouteDependencies {
  readonly store: TaskStore;
  /** Largest request body to accept, in bytes. Comes from configuration. */
  readonly maxBodyBytes: number;
}

/**
 * Register every task route on the given router.
 */
export function registerTaskRoutes(router: Router, deps: TaskRouteDependencies): void {
  const { store, maxBodyBytes } = deps;

  /**
   * `GET /api/tasks` -- list the collection.
   *
   * Supports `?completed=`, `?priority=`, `?limit=` and `?offset=`. See
   * `parseTaskListQuery` for the validation rules.
   *
   * **Why the body is a bare JSON array.** A common alternative is an envelope
   * like `{ "data": [...], "total": 137 }`. Both are defensible. The bare array
   * keeps the collection response identical in shape to what you would get from
   * any other JSON source, and puts the metadata in a header where HTTP already
   * has a place for it. An envelope is easier for clients that cannot read
   * headers -- many browser fetch wrappers, for instance. The choice matters less
   * than making it once and documenting it.
   */
  router.get('/api/tasks', (ctx) => {
    const query = parseTaskListQuery(ctx.url.searchParams);
    const { items, total } = store.list(query);

    // `X-Total-Count` is a de-facto standard (not a real RFC) for exactly this.
    // Custom headers should be prefixed with `X-` by convention, which is a
    // naming guideline rather than a requirement -- the `X-` prefix was formally
    // deprecated in 2012, but it remains in wide use and reads clearly.
    //
    // Note that `total` counts everything that matched the filters, before the
    // page was cut out. That is what lets a client show "showing 20 of 137".
    ctx.res.setHeader('X-Total-Count', String(total));

    sendJson(ctx.res, 200, items);
  });

  /**
   * `POST /api/tasks` -- create a task in the collection.
   *
   * Only 201 is used on success, never 200, because a new resource now exists at
   * a URL that did not exist before. The `Location` header names that URL, which
   * is what lets a client follow up without constructing the URL itself -- and
   * means you can change your URL scheme without breaking well-behaved clients.
   *
   * The body we return is the created task *including the server-generated id,
   * timestamps and defaults*. Returning the full representation saves the client
   * a follow-up GET and removes any ambiguity about what was actually stored.
   */
  router.post('/api/tasks', async (ctx) => {
    // `readJsonBody` returns `unknown`, and `parseTaskWriteInput` turns that
    // unknown into a value the rest of this function can trust. These two lines
    // are the whole of the trust boundary.
    const body = await readJsonBody(ctx.req, maxBodyBytes);
    const input = parseTaskWriteInput(body);

    const task = store.create(input);

    ctx.res.setHeader('Location', `/api/tasks/${task.id}`);
    sendJson(ctx.res, 201, task);
  });

  /**
   * `GET /api/tasks/:id` -- fetch a single task.
   *
   * Identical in shape to the collection response, but addressed directly. Both
   * exist on purpose: the collection is for discovery ("show me what is here"),
   * and a single resource is for a client that already knows what it wants.
   * Requiring a client to fetch 137 tasks to read one is a real cost.
   */
  router.get('/api/tasks/:id', (ctx) => {
    const task = store.findById(requireParam(ctx, 'id'));

    if (task === undefined) {
      // The message echoes the id back, which sounds harmless but is worth
      // noticing: anything a client sends, and that you echo into a response, is
      // potentially reflected content. It is safe in a JSON API because the
      // `Content-Type` is `application/json` and we send
      // `X-Content-Type-Options: nosniff`, so a browser will never render it as
      // HTML. Echoing user input into an HTML page is the classic reflected XSS
      // bug -- a different situation, and one to be careful about.
      throw new NotFoundError(`No task exists with id "${requireParam(ctx, 'id')}".`);
    }

    sendJson(ctx.res, 200, task);
  });

  /**
   * `PUT /api/tasks/:id` -- replace the entire task.
   *
   * **PUT means "make the resource look exactly like this body."** Fields you
   * omit are reset to their defaults, not left alone. That is the difference
   * between PUT and PATCH, and it is the reason PUT must be *idempotent*: sending
   * the same PUT twice must leave the resource in the same state as sending it
   * once, or a client retrying after a dropped connection would corrupt its own
   * data.
   *
   * **This endpoint does not create.** A strict reading of HTTP says PUT may
   * create a resource at a client-chosen URL. We deliberately do not, because ids
   * are server-generated UUIDs -- a client cannot know one in advance. So a PUT
   * to an unknown id is a 404, and creation happens exclusively through POST.
   * This is a documented deviation from the letter of the spec, and a very common
   * one.
   */
  router.put('/api/tasks/:id', async (ctx) => {
    const id = requireParam(ctx, 'id');
    const body = await readJsonBody(ctx.req, maxBodyBytes);
    const input = parseTaskWriteInput(body);

    const task = store.replace(id, input);
    if (task === undefined) {
      throw new NotFoundError(`No task exists with id "${id}".`);
    }

    sendJson(ctx.res, 200, task);
  });

  /**
   * `PATCH /api/tasks/:id` -- update some fields.
   *
   * The body may contain any subset of the writable fields. Fields that are
   * absent are left untouched, which is what makes PATCH the right choice for
   * toggling a checkbox: send `{"completed": true}` and nothing else, and the
   * title is safe even if another client changed it a moment ago.
   *
   * That safety has a name -- PATCH avoids the "lost update" problem that a
   * read-modify-write PUT cycle is vulnerable to -- and it is the main reason
   * PATCH exists at all.
   *
   * `sendNoContent` is deliberately not used here. Returning the updated resource
   * is a deliberate API design decision: it means the client does not have to
   * guess, and does not have to issue a follow-up GET, to learn what the server
   * actually stored -- including the new `updatedAt`.
   */
  router.patch('/api/tasks/:id', async (ctx) => {
    const id = requireParam(ctx, 'id');
    const body = await readJsonBody(ctx.req, maxBodyBytes);
    const patch = parseTaskUpdateInput(body);

    const task = store.update(id, patch);
    if (task === undefined) {
      throw new NotFoundError(`No task exists with id "${id}".`);
    }

    sendJson(ctx.res, 200, task);
  });

  /**
   * `DELETE /api/tasks/:id` -- delete a task.
   *
   * **204 No Content on success.** There is no resource left, so there is nothing
   * meaningful to return; a 200 with `{}` or `null` would only give the client
   * something to ignore. A 204 body must be completely empty.
   *
   * **404 when it is already gone.** The alternative is to return 204 for a
   * delete of something that never existed, which makes DELETE conveniently
   * idempotent but hides genuine mistakes -- a client deleting an id it got from
   * a typo will never learn it was wrong. Reporting 404 is the more useful
   * behaviour, and it is safe for retries as long as clients treat 404 as
   * "already done" on a delete they initiated.
   */
  router.delete('/api/tasks/:id', (ctx) => {
    const id = requireParam(ctx, 'id');

    // `store.delete` returns a boolean, so there is no separate existence check.
    // Checking first and deleting second would also be a race: two concurrent
    // deletes of the same id could both pass the check.
    const removed = store.delete(id);
    if (!removed) {
      throw new NotFoundError(`No task exists with id "${id}".`);
    }

    sendNoContent(ctx.res);
  });
}
