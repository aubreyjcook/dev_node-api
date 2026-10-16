/**
 * End-to-end integration tests.
 *
 * Every test here talks to a real HTTP server over a real socket. Nothing is
 * mocked. The value of that is that these tests check the contract a client
 * actually experiences -- the status code, the headers, the JSON shape -- rather
 * than the internals you happen to have written.
 *
 * Read this file as executable documentation. Each `it` name states one promise
 * the API makes, and the body shows exactly how much has to be true for the
 * promise to hold.
 *
 * Run with:
 *
 * ```bash
 * npm test
 * ```
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startTestServer, type TestServer } from './helpers/testServer.ts';

/** The fields of a task as they arrive over the wire. */
interface TaskPayload {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The error envelope every failure response uses. */
interface ErrorPayload {
  error: {
    code: string;
    message: string;
    details?: { field: string; message: string }[];
  };
}

describe('the tasks API over HTTP', () => {
  let server: TestServer;
  let baseUrl: string;

  before(async () => {
    // `seed: false` keeps these tests independent of the sample data. If the seed
    // list ever changes, these tests should not care.
    server = await startTestServer();
    baseUrl = server.baseUrl;
  });

  after(async () => {
    await server.close();
  });

  beforeEach(() => {
    // Start every test from an empty store. Without this, tests would pass or fail
    // depending on the order they ran in, which is the single most annoying kind
    // of test suite to debug.
    server.app.store.clear();
  });

  /** POST a JSON body to the collection. */
  async function createTask(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * Read a response body as JSON.
   *
   * `Response.json()` is typed `Promise<unknown>`, which is correct but tedious in
   * a test. This helper takes the type parameter the caller knows it expects. That
   * is a small act of faith -- genuinely verifying the shape is what the assertions
   * that follow are for.
   */
  async function readJson<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  describe('GET /health', () => {
    it('reports that the service is alive', async () => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);

      const body = await readJson<{ status: string; uptimeSeconds: number; nodeVersion: string }>(
        response,
      );
      assert.equal(body.status, 'ok');
      assert.equal(typeof body.uptimeSeconds, 'number');
      assert.equal(body.nodeVersion, process.version);
    });

    it('is not nested under /api, because it is infrastructure, not API', async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      assert.equal(response.status, 404);
    });
  });

  // -------------------------------------------------------------------------
  // Reading the collection
  // -------------------------------------------------------------------------

  describe('GET /api/tasks', () => {
    it('returns an empty array when there are no tasks', async () => {
      const response = await fetch(`${baseUrl}/api/tasks`);
      assert.equal(response.status, 200);
      assert.deepEqual(await readJson<TaskPayload[]>(response), []);
    });

    it('advertises JSON and confirms the declared content length', async () => {
      const response = await fetch(`${baseUrl}/api/tasks`);

      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
      // `no-store` keeps caches from handing a client a stale list after a write.
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

      // The body really is exactly as many bytes as the header claims. This is the
      // kind of invariant that a hand-rolled serializer can get wrong for non-ASCII
      // input, so it is worth asserting.
      const text = await response.text();
      assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(text, 'utf8')));
    });

    it('returns tasks in a stable, insertion order', async () => {
      for (const title of ['first', 'second', 'third']) {
        await createTask({ title });
      }

      const response = await fetch(`${baseUrl}/api/tasks`);
      const tasks = await readJson<TaskPayload[]>(response);
      assert.deepEqual(
        tasks.map((task) => task.title),
        ['first', 'second', 'third'],
      );
    });

    it('filters by completed', async () => {
      await createTask({ title: 'done', completed: true });
      await createTask({ title: 'todo', completed: false });

      const response = await fetch(`${baseUrl}/api/tasks?completed=true`);
      const tasks = await readJson<TaskPayload[]>(response);

      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.title, 'done');
    });

    it('filters by priority', async () => {
      await createTask({ title: 'urgent', priority: 'high' });
      await createTask({ title: 'whenever', priority: 'low' });

      const tasks = await readJson<TaskPayload[]>(await fetch(`${baseUrl}/api/tasks?priority=high`));
      assert.deepEqual(
        tasks.map((task) => task.title),
        ['urgent'],
      );
    });

    it('paginates and reports the unpaginated total in a header', async () => {
      for (const title of ['a', 'b', 'c']) {
        await createTask({ title });
      }

      const response = await fetch(`${baseUrl}/api/tasks?limit=1&offset=1`);
      const tasks = await readJson<TaskPayload[]>(response);

      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.title, 'b');
      // Three tasks matched; one was returned. The header is what lets a client
      // render "showing 1 of 3".
      assert.equal(response.headers.get('x-total-count'), '3');
    });

    it('rejects an unknown query parameter with 400', async () => {
      const response = await fetch(`${baseUrl}/api/tasks?nonsense=1`);
      assert.equal(response.status, 400);

      const body = await readJson<ErrorPayload>(response);
      assert.equal(body.error.code, 'BAD_REQUEST');
      assert.equal(body.error.details?.[0]?.field, 'nonsense');
    });

    it('rejects a limit that is not a number with 400', async () => {
      const response = await fetch(`${baseUrl}/api/tasks?limit=lots`);
      assert.equal(response.status, 400);
    });
  });

  // -------------------------------------------------------------------------
  // Reading one task
  // -------------------------------------------------------------------------

  describe('GET /api/tasks/:id', () => {
    it('returns the task', async () => {
      const created = await readJson<TaskPayload>(await createTask({ title: 'Read me' }));

      const response = await fetch(`${baseUrl}/api/tasks/${created.id}`);
      assert.equal(response.status, 200);

      const fetched = await readJson<TaskPayload>(response);
      assert.equal(fetched.id, created.id);
      assert.equal(fetched.title, 'Read me');
    });

    it('returns 404 for an id that does not exist', async () => {
      const response = await fetch(`${baseUrl}/api/tasks/0f8fad5b-d9cb-469f-a165-70867728950e`);
      assert.equal(response.status, 404);

      const body = await readJson<ErrorPayload>(response);
      assert.equal(body.error.code, 'NOT_FOUND');
      // The message names the id, which is what makes a 404 actionable when you
      // are staring at logs.
      assert.match(body.error.message, /0f8fad5b-d9cb-469f-a165-70867728950e/);
    });
  });

  // -------------------------------------------------------------------------
  // Creating
  // -------------------------------------------------------------------------

  describe('POST /api/tasks', () => {
    it('creates a task, returns 201, and points Location at the new resource', async () => {
      const response = await createTask({ title: 'Buy milk', priority: 'high' });
      assert.equal(response.status, 201);

      const task = await readJson<TaskPayload>(response);
      assert.equal(task.title, 'Buy milk');
      assert.equal(task.priority, 'high');
      assert.equal(task.completed, false);
      assert.equal(task.description, null);
      assert.ok(task.id.length > 0);

      // `Location` is what lets a client find the new resource without having to
      // know how ids are generated.
      assert.equal(response.headers.get('location'), `/api/tasks/${task.id}`);

      // And it must actually work.
      const followUp = await fetch(`${baseUrl}${response.headers.get('location')}`);
      assert.equal(followUp.status, 200);
    });

    it('accepts a JSON content type with a charset parameter', async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        // The parameter after the semicolon is legal and must not break the match.
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ title: 'Charsets are fine' }),
      });
      assert.equal(response.status, 201);
    });

    it('accepts a structured-syntax JSON type such as application/vnd.api+json', async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.api+json' },
        body: JSON.stringify({ title: 'Suffixes too' }),
      });
      // Rejecting these would be needlessly strict -- they are JSON.
      assert.equal(response.status, 201);
    });

    it('returns 415 when the content type is not JSON', async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ title: 'Plain text' }),
      });
      assert.equal(response.status, 415);

      const body = await readJson<ErrorPayload>(response);
      assert.equal(body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
    });

    it('returns 400 when the body is missing entirely', async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, { method: 'POST' });
      assert.equal(response.status, 400);
    });

    it('returns 400 when the body is not valid JSON', async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Truncated JSON: the closing brace never arrives.
        body: '{"title": "unterminated',
      });
      assert.equal(response.status, 400);

      const body = await readJson<ErrorPayload>(response);
      assert.match(body.error.message, /not valid JSON/);
    });

    it('returns 422 when the JSON is fine but the data is not', async () => {
      const response = await createTask({ title: '' });
      assert.equal(response.status, 422);

      const body = await readJson<ErrorPayload>(response);
      assert.equal(body.error.code, 'VALIDATION_FAILED');
      assert.deepEqual(body.error.details, [
        { field: 'title', message: 'Must not be empty or whitespace only.' },
      ]);
    });

    it('returns 422 with every problem listed at once', async () => {
      const response = await createTask({ title: 42, priority: 'urgent', oops: true });
      assert.equal(response.status, 422);

      const body = await readJson<ErrorPayload>(response);
      const fields = (body.error.details ?? []).map((issue) => issue.field).sort();
      assert.deepEqual(fields, ['oops', 'priority', 'title']);
    });

    it('distinguishes 400 (unparseable) from 422 (unacceptable)', async () => {
      // Same endpoint, same kind of mistake from the user's point of view, but two
      // very different diagnoses -- and the difference tells a client whether to
      // fix its serializer or its form validation.
      const syntaxError = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json at all',
      });
      const semanticError = await createTask({ title: '' });

      assert.equal(syntaxError.status, 400);
      assert.equal(semanticError.status, 422);
    });
  });

  // -------------------------------------------------------------------------
  // Replacing with PUT
  // -------------------------------------------------------------------------

  describe('PUT /api/tasks/:id', () => {
    it('replaces every content field and leaves omitted ones at their defaults', async () => {
      const created = await readJson<TaskPayload>(
        await createTask({ title: 'Original', description: 'Some text', priority: 'high', completed: true }),
      );

      const response = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Replaced' }),
      });
      assert.equal(response.status, 200);

      const replaced = await readJson<TaskPayload>(response);
      assert.equal(replaced.title, 'Replaced');
      // This is the whole point of PUT. Fields absent from the body are reset, not
      // preserved. If you wanted them preserved, you wanted PATCH.
      assert.equal(replaced.description, null);
      assert.equal(replaced.priority, 'medium');
      assert.equal(replaced.completed, false);
      // Identity and creation time are not content, so they survive.
      assert.equal(replaced.id, created.id);
      assert.equal(replaced.createdAt, created.createdAt);
    });

    it('is idempotent: sending the same body twice changes nothing the second time', async () => {
      const created = await readJson<TaskPayload>(await createTask({ title: 'Original' }));
      const body = JSON.stringify({ title: 'Stable', priority: 'low', completed: true });

      const first = await readJson<TaskPayload>(
        await fetch(`${baseUrl}/api/tasks/${created.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
        }),
      );
      const second = await readJson<TaskPayload>(
        await fetch(`${baseUrl}/api/tasks/${created.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
        }),
      );

      // `updatedAt` legitimately differs -- time passed. Everything a client would
      // compare to decide "did anything change?" must not.
      assert.equal(second.title, first.title);
      assert.equal(second.description, first.description);
      assert.equal(second.priority, first.priority);
      assert.equal(second.completed, first.completed);
      assert.equal(second.createdAt, first.createdAt);
    });

    it('returns 404 for an id that does not exist', async () => {
      const response = await fetch(`${baseUrl}/api/tasks/does-not-exist`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Nope' }),
      });
      // PUT does not create here, because ids are server-generated UUIDs and a
      // client cannot know one in advance.
      assert.equal(response.status, 404);
    });

    it('still validates the body', async () => {
      const created = await readJson<TaskPayload>(await createTask({ title: 'Original' }));

      const response = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority: 'high' }),
      });
      assert.equal(response.status, 422);
    });
  });

  // -------------------------------------------------------------------------
  // Updating with PATCH
  // -------------------------------------------------------------------------

  describe('PATCH /api/tasks/:id', () => {
    it('updates only the fields present in the body', async () => {
      const created = await readJson<TaskPayload>(
        await createTask({ title: 'Keep me', description: 'Keep this', priority: 'high' }),
      );

      const response = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      });
      assert.equal(response.status, 200);

      const patch = await readJson<TaskPayload>(response);
      assert.equal(patch.completed, true);
      // The deliberate contrast with the PUT test above: everything else survives.
      assert.equal(patch.title, 'Keep me');
      assert.equal(patch.description, 'Keep this');
      assert.equal(patch.priority, 'high');
    });

    it('clears the description when sent an explicit null', async () => {
      const created = await readJson<TaskPayload>(await createTask({ title: 'x', description: 'Remove me' }));

      const patch = await readJson<TaskPayload>(
        await fetch(`${baseUrl}/api/tasks/${created.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: null }),
        }),
      );
      assert.equal(patch.description, null);
    });

    it('updates updatedAt but not createdAt', async () => {
      const created = await readJson<TaskPayload>(await createTask({ title: 'x' }));

      const patch = await readJson<TaskPayload>(
        await fetch(`${baseUrl}/api/tasks/${created.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'y' }),
        }),
      );

      assert.equal(patch.createdAt, created.createdAt);
      assert.notEqual(patch.updatedAt, created.updatedAt);
    });

    it('returns 422 for an empty patch', async () => {
      const created = await readJson<TaskPayload>(await createTask({ title: 'x' }));

      const response = await fetch(`${baseUrl}/api/tasks/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 422);
    });

    it('returns 404 for an id that does not exist', async () => {
      const response = await fetch(`${baseUrl}/api/tasks/nope`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x' }),
      });
      assert.equal(response.status, 404);
    });
  });

  // -------------------------------------------------------------------------
  // Deleting
  // -------------------------------------------------------------------------

  describe('DELETE /api/tasks/:id', () => {
    it('returns 204 with a completely empty body', async () => {
      const created = await readJson<TaskPayload>(await createTask({ title: 'Delete me' }));

      const response = await fetch(`${baseUrl}/api/tasks/${created.id}`, { method: 'DELETE' });
      assert.equal(response.status, 204);

      // A 204 must not carry a body at all -- not even `null`.
      const text = await response.text();
      assert.equal(text, '');
      // And it must not declare a length for a body that does not exist.
      assert.equal(response.headers.get('content-length'), null);
    });

    it('really deletes the task', async () => {
      const created = await readJson<TaskPayload>(await createTask({ title: 'Delete me' }));
      await fetch(`${baseUrl}/api/tasks/${created.id}`, { method: 'DELETE' });

      const response = await fetch(`${baseUrl}/api/tasks/${created.id}`);
      assert.equal(response.status, 404);
    });

    it('returns 404 when deleting something that is already gone', async () => {
      const created = await readJson<TaskPayload>(await createTask({ title: 'Delete me' }));

      assert.equal((await fetch(`${baseUrl}/api/tasks/${created.id}`, { method: 'DELETE' })).status, 204);
      // Reporting 404 rather than 204 here is the choice that surfaces client bugs.
      assert.equal((await fetch(`${baseUrl}/api/tasks/${created.id}`, { method: 'DELETE' })).status, 404);
    });
  });

  // -------------------------------------------------------------------------
  // Routing errors
  // -------------------------------------------------------------------------

  describe('routing', () => {
    it('returns 404 with a JSON body for an unknown path', async () => {
      const response = await fetch(`${baseUrl}/api/nothing-here`);
      assert.equal(response.status, 404);
      // Even a 404 is JSON. A client should be able to parse every response from
      // the API the same way.
      assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    });

    it('returns 405 and an Allow header for a method the URL does not support', async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, { method: 'PATCH' });

      assert.equal(response.status, 405);
      // RFC 9110 requires a 405 response to say what IS allowed.
      const allow = response.headers.get('allow');
      assert.ok(allow !== null);
      assert.match(allow, /GET/);
      assert.match(allow, /POST/);
      assert.doesNotMatch(allow, /PATCH/);
    });

    it('returns 405 for PATCH on the health endpoint', async () => {
      const response = await fetch(`${baseUrl}/health`, { method: 'PATCH' });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET, OPTIONS');
    });

    it('does not match an extra path segment', async () => {
      const created = await readJson<TaskPayload>(await createTask({ title: 'x' }));
      const response = await fetch(`${baseUrl}/api/tasks/${created.id}/notes`);
      assert.equal(response.status, 404);
    });

    it('matches a trailing slash the same as no trailing slash', async () => {
      // Both URLs produce the same path segments, so both resolve. Users type
      // trailing slashes constantly and 404-ing them would be needlessly harsh.
      assert.equal((await fetch(`${baseUrl}/api/tasks/`)).status, 200);
    });

    it('decodes percent-encoded path segments', async () => {
      // The decoded id simply will not exist, but the point is that decoding
      // happened rather than the request being rejected as malformed. The error
      // message echoes the decoded value, so it is observable.
      const response = await fetch(`${baseUrl}/api/tasks/hello%20world`);
      assert.equal(response.status, 404);

      const body = await readJson<ErrorPayload>(response);
      assert.match(body.error.message, /hello world/);
    });

    it('returns 400 for a malformed percent-escape', async () => {
      const response = await fetch(`${baseUrl}/api/tasks/%zz`);
      assert.equal(response.status, 400);
    });
  });

  // -------------------------------------------------------------------------
  // Body limits
  // -------------------------------------------------------------------------

  describe('request body limits', () => {
    it('returns 413 when the body exceeds the configured maximum', async () => {
      // A server that buffers an unbounded body will happily read a huge request
      // into memory. Polling `Content-Length` first means we reject this before
      // transferring the payload.
      const response = await createTask({ title: 'a'.repeat(200_000) });
      assert.equal(response.status, 413);

      const body = await readJson<ErrorPayload>(response);
      assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
    });

    it('honours a smaller configured limit', async () => {
      const tiny = await startTestServer({ maxBodyBytes: 40 });
      try {
        const response = await fetch(`${tiny.baseUrl}/api/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'This body is longer than forty bytes' }),
        });
        assert.equal(response.status, 413);
      } finally {
        await tiny.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // CORS
  // -------------------------------------------------------------------------

  describe('CORS', () => {
    it('answers a preflight request with 204 and the allowed methods', async () => {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
      // Without Content-Type in this list, a browser would block every JSON write.
      assert.match(response.headers.get('access-control-allow-headers') ?? '', /Content-Type/i);
    });

    it('answers a preflight on a path that has no routes', async () => {
      // Preflight is handled before routing, which is why this succeeds even
      // though GET on the same path would be a 404. This is intentional: the
      // browser is asking about the API as a whole, not about a resource.
      const response = await fetch(`${baseUrl}/api/does-not-exist`, { method: 'OPTIONS' });
      assert.equal(response.status, 204);
    });

    it('includes the CORS header on error responses too', async () => {
      // A browser cannot read a response that lacks this header, which would turn
      // a clear 404 into an opaque network error in the console.
      const response = await fetch(`${baseUrl}/api/tasks/nope`, {
        headers: { Origin: 'https://example.com' },
      });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
    });
  });
});

// ---------------------------------------------------------------------------
// A note on what is deliberately not tested here
// ---------------------------------------------------------------------------
//
// - Middleware ordering. The value of the order in `app.ts` is argued in its
//   comments; testing it would mean asserting on log output, which is brittle.
// - Graceful shutdown. `server.ts` runs at import time, so it cannot be imported
//   by a test without starting a real server on a fixed port. Extracting a
//   `startServer(config)` function would make it testable -- a good exercise.
// - Concurrent writes. Node runs your JavaScript on one thread, so there is no
//   true parallelism to test against an in-memory Map. The moment a database is
//   involved, this becomes essential.
