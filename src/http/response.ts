/**
 * Helpers for writing responses.
 *
 * Every response in this API goes out through one of the two functions below.
 * That is worth doing even in a tiny project: it means the details of how a
 * response is shaped (which headers, how the body is serialized, how errors are
 * formatted) live in exactly one place instead of being repeated in every
 * handler.
 */

import type { ServerResponse } from 'node:http';
import type { HttpError } from './errors.ts';

/**
 * The `Content-Type` we send for JSON.
 *
 * The `charset=utf-8` parameter matters more than people expect. JSON is
 * *always* UTF-8 by specification, but some HTTP clients and older browsers
 * still guess ISO-8859-1 when no charset is declared, and then your accented
 * characters and emoji arrive mangled.
 */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Send a JSON response with the given status code.
 *
 * Two things are happening here that are worth understanding.
 *
 * **We compute `Content-Length` ourselves.** `JSON.stringify` gives us a string;
 * `Buffer.byteLength` gives us the number of *bytes* it occupies when encoded as
 * UTF-8, which is not the same as `string.length` for any non-ASCII character
 * (`'é'.length` is 1, but it is 2 bytes). Declaring the length up front means
 * Node can send a single response with a known size rather than falling back to
 * chunked transfer encoding, and the client knows exactly how much to read.
 *
 * **Headers set earlier are preserved.** `res.writeHead(status, headers)` does
 * not replace headers that were set with `res.setHeader(...)`; it merges them,
 * with the object passed here winning on conflicts. That is why middleware can
 * call `res.setHeader('Access-Control-Allow-Origin', ...)` long before the
 * handler runs, and those headers still appear on the final response.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  const bytes = Buffer.from(payload, 'utf8');

  res.writeHead(status, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Content-Length': String(bytes.byteLength),
    ...headers,
  });
  res.end(bytes);
}

/**
 * Send a `204 No Content` response -- success with deliberately no body.
 *
 * This is the correct response to a successful `DELETE`. The resource is gone,
 * so there is nothing meaningful to return, and a 200 with `{}` or `null` would
 * just be noise for the client to ignore.
 *
 * A 204 response must not have a body, and `res.end()` with no argument
 * guarantees that. It must also not declare a `Content-Length`, which is why we
 * do not set one here.
 */
export function sendNoContent(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(204, headers);
  res.end();
}

/**
 * Turn an `HttpError` into the standard error envelope and send it.
 *
 * `extraHeaders` exists for the one case where an error needs to influence a
 * response header: a 405 must carry an `Allow` header.
 */
export function sendError(
  res: ServerResponse,
  error: HttpError,
  extraHeaders: Record<string, string> = {},
): void {
  const envelope = {
    error: {
      code: error.code,
      message: error.message,
      // Only include `details` when there actually are some. Spreading an empty
      // object is a convenient way to add a property conditionally.
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };

  sendJson(res, error.status, envelope, extraHeaders);
}
