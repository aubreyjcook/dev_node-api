/**
 * The entry point.
 *
 * Run it directly:
 *
 * ```bash
 * npm run dev     # node --watch, restarts on every file save
 * npm start       # runs the compiled JavaScript in dist/
 * ```
 *
 * This file has exactly one job: start an HTTP server and shut it down cleanly.
 * All the interesting decisions live in `app.ts` and the modules it imports, and
 * keeping that separation is what lets the tests build an app without also
 * starting a server on a fixed port.
 */

import { createServer } from 'node:http';
import { buildApp } from './app.ts';
import { config } from './config.ts';

/** How long to wait for in-flight requests before forcing the process to exit. */
const SHUTDOWN_GRACE_MS = 10_000;

const app = buildApp();

/**
 * `createServer` takes a listener and wraps it in an HTTP server, but it does not
 * bind a port yet. Nothing is listening at this point.
 */
const server = createServer(app.listener);

/**
 * Startup failures arrive here rather than being thrown, because binding a port
 * is asynchronous. The most common one by far is `EADDRINUSE` -- the port is
 * already taken, usually by a previous run of this same server that you forgot
 * about, or by something else on port 3000.
 */
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${config.port} is already in use.\n` +
        `  - Something else is listening there. On Windows, find it with:\n` +
        `      Get-NetTCPConnection -LocalPort ${config.port} | Select-Object OwningProcess\n` +
        `  - Or start this server on a different port:  $env:PORT=3001; npm run dev\n` +
        `  - Note that PORT=3001 npm run dev does NOT work in PowerShell; that syntax is bash-only.\n`,
    );
  } else {
    console.error('\nThe server failed to start:', error);
  }

  // Set an exit code rather than calling `process.exit` immediately. That lets
  // any pending output flush before the process ends, which is why the message
  // above is not occasionally swallowed.
  process.exitCode = 1;
});

/**
 * `listen` is asynchronous, so the callback is where we know the server is really
 * up. Printing the banner before this point would be a lie whenever the port is
 * unavailable.
 */
server.listen(config.port, config.host, () => {
  // `server.address()` reports what we actually bound to. This matters because
  // passing port 0 asks the operating system to choose a free port, and we would
  // otherwise have no way to tell the user (or a test) which one it picked.
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : config.port;

  console.log('');
  console.log(`  dev_node-api  listening on http://${config.host}:${port}`);
  console.log(`  environment   ${config.nodeEnv}`);
  console.log(`  node          ${process.version}`);
  console.log('');
  console.log(`  Try it:       curl http://${config.host}:${port}/health`);
  console.log(`                curl http://${config.host}:${port}/api/tasks`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

/**
 * Graceful shutdown.
 *
 * The goal is to stop accepting new work and finish the work already in progress,
 * rather than cutting connections mid-request. Node gives us the pieces:
 *
 *   - `server.close(cb)` stops listening and calls `cb` once every connection has
 *     been closed. Crucially, it does *not* close idle keep-alive connections --
 *     it waits for them, and they can sit there for a long time.
 *   - `server.closeIdleConnections()` closes the ones that are between requests,
 *     which is what actually lets `close` finish promptly.
 *   - `server.closeAllConnections()` force-closes everything, including requests
 *     still being handled. That is the big hammer for the timeout below.
 *
 * Without this, `npm run dev` on Windows can leave the port held for a few
 * seconds after Ctrl+C, and your next start fails with `EADDRINUSE`.
 */
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    // A second Ctrl+C means "I meant it". Users expect this to be immediate, so
    // do not make them wait out the grace period twice.
    console.log(`\nReceived ${signal} again. Exiting immediately.`);
    process.exit(1);
  }
  shuttingDown = true;

  console.log(`\nReceived ${signal}. Finishing in-flight requests...`);

  server.close((error) => {
    if (error !== undefined) {
      console.error('Error while closing the server:', error);
      process.exit(1);
    }
    console.log('Server closed cleanly. Goodbye.');
    process.exit(0);
  });

  // Let the connections that are merely idle (keep-alive sockets between
  // requests) go, so `close` is not held open by a browser that has finished
  // with us but has not hung up.
  server.closeIdleConnections();

  // Anything genuinely still mid-request gets a grace period.
  const forceExit = setTimeout(() => {
    console.warn(
      `Requests are still in flight after ${SHUTDOWN_GRACE_MS}ms. Closing them forcibly.`,
    );
    server.closeAllConnections();
  }, SHUTDOWN_GRACE_MS);

  // `unref()` tells Node's event loop not to keep the process alive just for this
  // timer. Without it, a clean shutdown would always wait the full ten seconds
  // before the process could exit.
  forceExit.unref();
}

// SIGINT  = Ctrl+C in a terminal.
// SIGTERM = the polite shutdown signal, used by Docker, systemd and most process
//           managers. (Windows has no real SIGTERM, but registering the handler
//           is harmless and it is what you want on Linux and in containers.)
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
