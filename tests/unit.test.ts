/**
 * Unit tests for the store and the validators.
 *
 * These are the two modules with real logic in them -- everything else is
 * plumbing. Testing them directly means failures point at the exact function that
 * broke, rather than at "something in the HTTP response was wrong".
 *
 * Run with:
 *
 * ```bash
 * npm test
 * ```
 *
 * Node's built-in test runner is used deliberately: `node --test` needs no
 * dependencies, no configuration and no globals. `describe` and `it` come from
 * `node:test` and behave the same way as the Jest or Mocha versions you may have
 * seen.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskStore } from '../src/data/task.store.ts';
import { HttpError } from '../src/http/errors.ts';
import {
  MAX_TITLE_LENGTH,
  parseTaskListQuery,
  parseTaskUpdateInput,
  parseTaskWriteInput,
} from '../src/validation/task.validation.ts';
import type { TaskWriteInput } from '../src/types/task.ts';

/**
 * A convenient valid input, so each test only has to state what it is changing.
 *
 * Writing a test as "the valid thing, except for this one difference" makes the
 * intent obvious and stops the test from accidentally depending on some other
 * field being wrong.
 */
function validInput(overrides: Partial<TaskWriteInput> = {}): TaskWriteInput {
  return {
    title: 'Write tests',
    description: null,
    priority: 'medium',
    completed: false,
    ...overrides,
  };
}

/**
 * Run a function that is expected to throw an `HttpError`, and return that error.
 *
 * `assert.throws` can do something similar, but it does not hand the error back,
 * and asserting on the `status` and `code` is the entire point of most of these
 * tests. A helper that returns the caught error keeps each test to one or two
 * lines.
 */
function captureHttpError(run: () => unknown): HttpError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof HttpError) {
      return error;
    }
    throw new Error(`Expected an HttpError, but a different value was thrown: ${String(error)}`);
  }
  throw new Error('Expected the function to throw, but it returned normally.');
}

describe('TaskStore', () => {
  it('creates a task with a generated id and matching timestamps', () => {
    const store = new TaskStore();
    const task = store.create(validInput({ title: 'Buy milk' }));

    assert.equal(task.title, 'Buy milk');
    // A UUID v4 looks like '3f2504e0-4f89-11d3-9a0c-0305e82c3301' -- 36 characters
    // including the hyphens. Checking the shape rather than the value is the right
    // level of strictness; the value is random by design.
    assert.match(task.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(task.createdAt, task.updatedAt);
    // ISO 8601 in UTC always ends with 'Z'.
    assert.match(task.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('gives every task a distinct id', () => {
    const store = new TaskStore();
    const first = store.create(validInput());
    const second = store.create(validInput());

    assert.notEqual(first.id, second.id);
  });

  it('returns undefined from findById for an unknown id', () => {
    const store = new TaskStore();
    assert.equal(store.findById('does-not-exist'), undefined);
  });

  it('filters by completed and by priority, and reports the pre-pagination total', () => {
    const store = new TaskStore();
    store.create(validInput({ title: 'A', priority: 'high', completed: false }));
    store.create(validInput({ title: 'B', priority: 'low', completed: true }));
    store.create(validInput({ title: 'C', priority: 'high', completed: false }));

    const highPriority = store.list({ priority: 'high', limit: 10, offset: 0 });
    assert.equal(highPriority.items.length, 2);
    assert.equal(highPriority.total, 2);

    const unfinished = store.list({ completed: false, limit: 10, offset: 0 });
    assert.equal(unfinished.items.length, 2);

    // `limit` cuts the page but `total` still counts every match, which is what
    // makes "showing 1 of 2" possible on the client.
    const firstPage = store.list({ priority: 'high', limit: 1, offset: 0 });
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.total, 2);
  });

  it('paginates with limit and offset and returns an empty page past the end', () => {
    const store = new TaskStore();
    store.create(validInput({ title: 'one' }));
    store.create(validInput({ title: 'two' }));
    store.create(validInput({ title: 'three' }));

    const page = store.list({ limit: 2, offset: 1 });
    assert.deepEqual(
      page.items.map((task) => task.title),
      ['two', 'three'],
    );
    assert.equal(page.total, 3);

    const pastTheEnd = store.list({ limit: 2, offset: 99 });
    assert.deepEqual(pastTheEnd.items, []);
    assert.equal(pastTheEnd.total, 3);
  });

  it('treats an absent filter as "no opinion" rather than "false"', () => {
    const store = new TaskStore();
    store.create(validInput({ completed: false }));
    store.create(validInput({ completed: true }));

    // No `completed` key at all -> both tasks, unlike `completed: false` -> one.
    assert.equal(store.list({ limit: 10, offset: 0 }).total, 2);
    assert.equal(store.list({ completed: false, limit: 10, offset: 0 }).total, 1);
  });

  it('replaces every content field on PUT but preserves id and createdAt', () => {
    const store = new TaskStore();
    const created = store.create(
      validInput({ title: 'Original', description: 'Original text', priority: 'high', completed: true }),
    );

    const replaced = store.replace(
      created.id,
      validInput({ title: 'Replaced', description: null, priority: 'low', completed: false }),
    );
    assert.ok(replaced !== undefined);

    assert.equal(replaced.title, 'Replaced');
    // The description was omitted from the replacement, so it is gone. This is the
    // essence of PUT: the body is the complete new state.
    assert.equal(replaced.description, null);
    assert.equal(replaced.priority, 'low');
    assert.equal(replaced.completed, false);
    // Identity and creation time belong to the resource, not to its contents.
    assert.equal(replaced.id, created.id);
    assert.equal(replaced.createdAt, created.createdAt);
  });

  it('returns undefined when replacing or updating a task that does not exist', () => {
    const store = new TaskStore();
    assert.equal(store.replace('nope', validInput()), undefined);
    assert.equal(store.update('nope', { title: 'x' }), undefined);
  });

  it('leaves unmentioned fields alone on PATCH', () => {
    const store = new TaskStore();
    const created = store.create(
      validInput({ title: 'Keep me', description: 'Keep this too', priority: 'high' }),
    );

    const updated = store.update(created.id, { completed: true });
    assert.ok(updated !== undefined);

    assert.equal(updated.completed, true);
    assert.equal(updated.title, 'Keep me');
    assert.equal(updated.description, 'Keep this too');
    assert.equal(updated.priority, 'high');
  });

  it('clears the description on PATCH with an explicit null', () => {
    const store = new TaskStore();
    const created = store.create(validInput({ description: 'Remove me' }));

    // This is the `??` versus `=== undefined` trap in `TaskStore.update`. Using
    // `patch.description ?? existing.description` would treat the client's
    // deliberate `null` as "no change" and silently keep the old text.
    const updated = store.update(created.id, { description: null });
    assert.ok(updated !== undefined);
    assert.equal(updated.description, null);
  });

  it('reports whether a delete actually removed something', () => {
    const store = new TaskStore();
    const created = store.create(validInput());

    assert.equal(store.delete(created.id), true);
    // The second delete is what the handler turns into a 404.
    assert.equal(store.delete(created.id), false);
    assert.equal(store.count(), 0);
  });

  it('empties itself with clear', () => {
    const store = new TaskStore();
    store.seed([validInput(), validInput()]);
    assert.equal(store.count(), 2);

    store.clear();
    assert.equal(store.count(), 0);
  });
});

describe('parseTaskWriteInput', () => {
  it('applies defaults for every optional field', () => {
    const input = parseTaskWriteInput({ title: 'Only a title' });

    assert.deepEqual(input, {
      title: 'Only a title',
      description: null,
      priority: 'medium',
      completed: false,
    });
  });

  it('trims surrounding whitespace from the title', () => {
    assert.equal(parseTaskWriteInput({ title: '  Padded  ' }).title, 'Padded');
  });

  it('normalises an empty description to null', () => {
    // '' and null both mean "no description". Collapsing them here means no
    // consumer ever has to decide which one it is looking at.
    assert.equal(parseTaskWriteInput({ title: 'x', description: '   ' }).description, null);
  });

  it('rejects a body that is not a JSON object', () => {
    for (const body of ['a string', 42, true, null, ['an', 'array']]) {
      const error = captureHttpError(() => parseTaskWriteInput(body));
      assert.equal(error.status, 422);
      assert.equal(error.code, 'VALIDATION_FAILED');
    }
  });

  it('requires a non-empty title', () => {
    for (const title of [undefined, '', '   ', 42, null]) {
      const error = captureHttpError(() => parseTaskWriteInput({ title }));
      assert.equal(error.status, 422);
    }
  });

  it('rejects a title longer than the limit', () => {
    const error = captureHttpError(() =>
      parseTaskWriteInput({ title: 'a'.repeat(MAX_TITLE_LENGTH + 1) }),
    );
    assert.equal(error.status, 422);
    assert.deepEqual(error.details, [
      {
        field: 'title',
        message: `Must be at most ${MAX_TITLE_LENGTH} characters. Received ${MAX_TITLE_LENGTH + 1}.`,
      },
    ]);
  });

  it('rejects an unknown priority and accepts every valid one', () => {
    assert.equal(parseTaskWriteInput({ title: 'x', priority: 'high' }).priority, 'high');

    const error = captureHttpError(() => parseTaskWriteInput({ title: 'x', priority: 'urgent' }));
    assert.equal(error.status, 422);
  });

  it('rejects the string "true" for a boolean field', () => {
    // A JSON body has real booleans available, so accepting the string form would
    // be sloppy. (`?completed=true` in a query string is a different situation --
    // query values are always strings, and the validator handles that separately.)
    const error = captureHttpError(() => parseTaskWriteInput({ title: 'x', completed: 'true' }));
    assert.equal(error.status, 422);
  });

  it('rejects an unknown field rather than ignoring it', () => {
    const error = captureHttpError(() => parseTaskWriteInput({ title: 'x', titel: 'oops' }));
    assert.equal(error.status, 422);
    // The issue is reported against the misspelled key, so a client can point at
    // the offending property.
    assert.deepEqual(error.details, [
      { field: 'titel', message: 'Unknown field. This endpoint accepts: title, description, priority, completed.' },
    ]);
  });

  it('reports every problem at once instead of stopping at the first', () => {
    const error = captureHttpError(() =>
      parseTaskWriteInput({ title: '', priority: 'nope', completed: 5 }),
    );
    assert.equal(error.status, 422);

    // Collecting rather than failing fast means one round trip tells a client
    // everything that is wrong with its form.
    const fields = (error.details as { field: string }[]).map((issue) => issue.field).sort();
    assert.deepEqual(fields, ['completed', 'priority', 'title']);
  });
});

describe('parseTaskUpdateInput', () => {
  it('accepts a single field and returns only that field', () => {
    // Note the difference from the full write above: no defaults are filled in,
    // because an absent field must stay absent to mean "leave it alone".
    assert.deepEqual(parseTaskUpdateInput({ completed: true }), { completed: true });
  });

  it('distinguishes an explicit null description from an absent one', () => {
    assert.deepEqual(parseTaskUpdateInput({ description: null }), { description: null });
    // `{}` is rejected by the "at least one field" rule, so this is the only way to
    // express "change nothing about the description".
    const error = captureHttpError(() => parseTaskUpdateInput({}));
    assert.equal(error.status, 422);
  });

  it('rejects an empty patch', () => {
    const error = captureHttpError(() => parseTaskUpdateInput({}));
    assert.equal(error.status, 422);
    assert.match(error.message, /at least one field/);
  });

  it('still validates the fields that are present', () => {
    const error = captureHttpError(() => parseTaskUpdateInput({ title: '' }));
    assert.equal(error.status, 422);
  });
});

describe('parseTaskListQuery', () => {
  it('applies sensible defaults for an empty query string', () => {
    assert.deepEqual(parseTaskListQuery(new URLSearchParams()), { limit: 20, offset: 0 });
  });

  it('parses booleans, priorities and numbers', () => {
    const query = parseTaskListQuery(
      new URLSearchParams('completed=true&priority=high&limit=5&offset=10'),
    );
    assert.deepEqual(query, { completed: true, priority: 'high', limit: 5, offset: 10 });
  });

  it('returns a 400 (not a 422) for a bad query parameter', () => {
    // Query parameters are part of the URL, so getting them wrong makes the
    // request itself malformed rather than the body semantically invalid.
    const error = captureHttpError(() => parseTaskListQuery(new URLSearchParams('limit=abc')));
    assert.equal(error.status, 400);
    assert.equal(error.code, 'BAD_REQUEST');
  });

  it('rejects an empty value for a numeric parameter', () => {
    // `Number('')` is 0, which is a perfectly good integer, so without an explicit
    // empty-string check `?limit=` would quietly mean zero.
    const error = captureHttpError(() => parseTaskListQuery(new URLSearchParams('limit=')));
    assert.equal(error.status, 400);
  });

  it('rejects a limit above the maximum', () => {
    const error = captureHttpError(() => parseTaskListQuery(new URLSearchParams('limit=1000')));
    assert.equal(error.status, 400);
  });

  it('rejects unknown query parameters', () => {
    const error = captureHttpError(() => parseTaskListQuery(new URLSearchParams('completd=true')));
    assert.equal(error.status, 400);
    assert.deepEqual(error.details, [
      {
        field: 'completd',
        message: 'Unknown query parameter. Supported parameters are: completed, priority, limit, offset.',
      },
    ]);
  });

  it('rejects a non-boolean completed value', () => {
    const error = captureHttpError(() => parseTaskListQuery(new URLSearchParams('completed=yes')));
    assert.equal(error.status, 400);
  });
});
