/**
 * A throwaway HTTP server for integration tests.
 *
 * The tests exercise the real thing: a real `http.Server`, a real TCP socket on a
 * real port, and real `fetch` requests. That means they catch bugs that a unit
 * test of a handler function would sail straight past -- header casing, status
 * codes, body serialization, middleware ordering, and whether the response is
 * valid HTTP at all.
 *
 * Two details make this practical:
 *
 *   - **Port 0.** Asking the operating system for a free port means many test
 *     servers can run at once without colliding, and you never have to remember
 *     to free port 3000. The chosen port is read back from `server.address()`.
 *   - **`closeAllConnections`.** `fetch` keeps connections alive in a pool after
 *     the response arrives. `server.close()` waits for every open connection, so
 *     without forcing them shut the test process would hang at the end.
 */

import { createServer } from 'node:http';
import { buildApp, type App, type BuildAppOptions } from '../../src/app.ts';

/** A running test server, plus the two things a test needs: a URL and a shutdown. */
export interface TestServer {
  readonly app: App;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

/**
 * Start an app on a random free port.
 *
 * Logging and seeding are off by default so test output stays readable and each
 * test is unaffected by sample data. Pass `overrides` to change either.
 */
export async function startTestServer(overrides: BuildAppOptions = {}): Promise<TestServer> {
  const app = buildApp({ logRequests: false, seed: false, ...overrides });
  const server = createServer(app.listener);

  await new Promise<void>((resolve, reject) => {
    // `once` rather than `on`: if binding fails we do not want this listener to
    // linger and swallow a later error.
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  // `address()` returns `null` before binding, a string for a Unix domain socket,
  // or an object for TCP. TypeScript makes us handle all three; the first two are
  // impossible here, which is exactly what the guard is asserting.
  if (address === null || typeof address === 'string') {
    throw new Error('Expected the test server to be listening on a TCP address.');
  }

  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      // Force idle keep-alive sockets shut first, otherwise `close` never settles.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}
