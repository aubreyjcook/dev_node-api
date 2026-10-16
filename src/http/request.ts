/**
 * Reading the request.
 *
 * In a framework like Express you would write `req.body` and get an object. Here
 * there is no `req.body`, because Node's `IncomingMessage` is a *stream*: the
 * body arrives as a sequence of chunks, possibly spread over several network
 * packets, and the server sets up the parser before any of it has arrived. Some
 * code has to collect those chunks and parse them, and in a barebones API that
 * code is ours.
 *
 * Doing it by hand is genuinely educational once: `req.body` is not magic, it is
 * a middleware that does roughly what `readJsonBody` does below.
 */

import type { IncomingMessage } from 'node:http';
import {
  BadRequestError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
} from './errors.ts';

/**
 * Matches the JSON media types we accept.
 *
 * Breaking the pattern down:
 *   `^application\/`      -- must start with `application/`
 *   `(?:[\w.+-]+\+)?`     -- an optional structured-syntax suffix, e.g. `vnd.api+`
 *   `json$`               -- must end with `json`
 *
 * So this accepts `application/json`, and also the many JSON-based types that
 * append a suffix: `application/vnd.api+json`, `application/ld+json`, and so on.
 * Rejecting those would be needlessly strict -- they *are* JSON.
 */
const JSON_MEDIA_TYPE = /^application\/(?:[\w.+-]+\+)?json$/;

/**
 * Is this `Content-Type` header value one of the JSON types we accept?
 *
 * The header may carry parameters, as in `application/json; charset=utf-8`. Only
 * the part before the first `;` is the media type, so we cut it off and compare
 * case-insensitively (media types are case-insensitive per the HTTP spec, even
 * though everyone writes them lowercase).
 */
function isJsonMediaType(contentType: string): boolean {
  const semiColonIndex = contentType.indexOf(';');
  const mediaType = semiColonIndex === -1 ? contentType : contentType.slice(0, semiColonIndex);
  return JSON_MEDIA_TYPE.test(mediaType.trim().toLowerCase());
}

/**
 * Drain the request stream into a single string, refusing to buffer more than
 * `maxBytes`.
 *
 * `for await (const chunk of req)` uses the async iterator protocol. Node
 * implements it on streams, so this loop yields each chunk as it arrives and
 * pauses the underlying socket between iterations. It is the modern, readable
 * alternative to the classic `req.on('data', ...)` / `req.on('end', ...)` pair.
 *
 * **Why the size limit matters.** A server that buffers an unbounded body will
 * happily read a 10 GB request into memory and fall over. This is a real class of
 * denial-of-service attack, and a body limit is the basic defence.
 */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  // If the client told us up front that the body is too big, we can reject it
  // before transferring a single byte. `Number.parseInt` returns NaN for a
  // missing or malformed header, and `Number.isInteger(NaN)` is false, so the
  // check is skipped in exactly those cases.
  const declaredLength = Number.parseInt(req.headers['content-length'] ?? '', 10);
  if (Number.isInteger(declaredLength) && declaredLength > maxBytes) {
    throw new PayloadTooLargeError(maxBytes);
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  for await (const chunk of req) {
    // Node hands stream iterators `Buffer` chunks for HTTP requests. The cast
    // documents that expectation; if a chunk ever arrived as a string, the cast
    // would be a lie and `byteLength` below would be undefined.
    const buffer = chunk as Buffer;
    receivedBytes += buffer.byteLength;

    // The announced length can be absent (chunked transfer encoding) or simply
    // wrong, so the real enforcement happens here as the data streams in.
    if (receivedBytes > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }

  // `Buffer.concat` joins the chunks and `toString('utf8')` decodes them.
  // Concatenating *buffers* and decoding once at the end -- rather than decoding
  // each chunk separately -- is the correct order, because a multi-byte UTF-8
  // character can be split across two chunk boundaries.
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Read and parse a JSON request body.
 *
 * The return type is `unknown`, and that is the single most important line in
 * this file. `JSON.parse` in a TypeScript project is typed `any`, which switches
 * off type checking for every value it touches. Declaring the result as
 * `unknown` forces the caller to prove what the data is before using it -- which
 * is exactly what `validation/task.validation.ts` does next.
 *
 * Each failure mode maps to a different status code, and the order of the checks
 * is chosen so the client gets the most useful message:
 *
 *   - empty body                  -> 400 (there was nothing to parse)
 *   - missing/non-JSON Content-Type -> 415 (we cannot read this format)
 *   - malformed JSON              -> 400 (syntax problem)
 *   - valid JSON, wrong contents  -> 422 (handled by the validator, not here)
 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const raw = await readRawBody(req, maxBytes);

  if (raw.trim().length === 0) {
    throw new BadRequestError(
      'A JSON request body is required for this endpoint. This request had an empty body.',
    );
  }

  const contentType = req.headers['content-type'];
  if (contentType === undefined || !isJsonMediaType(contentType)) {
    throw new UnsupportedMediaTypeError(
      'This endpoint requires a JSON request body. Send the header "Content-Type: application/json".',
    );
  }

  try {
    // Annotating the variable as `unknown` (rather than asserting a shape) keeps
    // the value opaque to the type checker until it has been validated.
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch (cause) {
    // The underlying `SyntaxError` message is genuinely helpful here -- it names
    // the offending position in the text -- and it describes the *client's* own
    // input, so unlike an internal error it is safe to pass along.
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new BadRequestError(`The request body is not valid JSON: ${detail}`);
  }
}
