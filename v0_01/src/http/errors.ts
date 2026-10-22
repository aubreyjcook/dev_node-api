/**
 * The error vocabulary of the API.
 *
 * The idea is simple: anywhere in the code, a function that discovers a problem
 * can `throw new NotFoundError(...)`. Deep down in a store or a validator, that
 * function does not know or care about HTTP -- it just describes what went wrong.
 * A single piece of middleware (`middleware/errorHandler.ts`) sits near the top
 * of the pipeline, catches everything, and translates it into a JSON response.
 *
 * That separation is what keeps status codes out of your business logic.
 */

/**
 * The body we send when something goes wrong:
 *
 * ```json
 * {
 *   "error": {
 *     "code": "VALIDATION_FAILED",
 *     "message": "The request body failed validation.",
 *     "details": [{ "field": "title", "message": "Title is required." }]
 *   }
 * }
 * ```
 *
 * A stable, machine-readable `code` alongside a human-readable `message` is a
 * very common API convention. Clients branch on `code`; humans read `message`.
 * Never make a client parse `message` -- you will want to reword it eventually.
 */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * The base class for every error that has a deliberate HTTP meaning.
 *
 * Two details worth noticing:
 *
 * 1. We declare the fields, then assign them in the constructor. TypeScript has
 *    a shorthand for exactly this -- `constructor(readonly status: number)` --
 *    called a *parameter property*. We cannot use it here because it generates
 *    assignment code rather than just annotating existing code, which makes it
 *    impossible for Node to merely strip the types. Our `erasableSyntaxOnly`
 *    setting rejects it. See docs/02 for the full explanation.
 *
 * 2. `this.name = new.target.name` gives each subclass a useful `name`.
 *    Without it, every subclass would report `name === 'Error'`, and your logs
 *    would say `Error: ...` for everything. `new.target` is plain JavaScript:
 *    it refers to the constructor that was actually used with `new`.
 */
export class HttpError extends Error {
  /** The HTTP status code this error maps to, e.g. `404`. */
  readonly status: number;
  /** A stable, SCREAMING_SNAKE_CASE identifier for clients to branch on. */
  readonly code: string;
  /**
   * Optional structured extra information, most often a list of validation
   * problems. Typed `unknown` because it is arbitrary JSON we are handing
   * straight to the serializer -- and it is also serialized, so it must never
   * contain anything secret.
   */
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    // `super(message)` must be the first statement in a subclass constructor.
    // It sets up the JavaScript `Error` machinery: `message`, `stack`, and so on.
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * 400 Bad Request.
 *
 * The request is malformed at the *syntax* level: broken JSON, a missing body, or
 * a query parameter that is not even the right kind of thing (`?limit=abc`).
 *
 * Rule of thumb: if we cannot get as far as understanding the data, it is 400.
 */
export class BadRequestError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

/**
 * 404 Not Found.
 *
 * Either no route matches the URL, or the resource the URL identifies does not
 * exist. Both produce the same status code on purpose -- a client asking for
 * `/api/tasks/nope` and a client asking for `/api/nonsense` are both told the
 * same thing, which also avoids leaking which URLs the API implements.
 */
export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
  }
}

/**
 * 405 Method Not Allowed.
 *
 * The URL exists but not for this method -- e.g. `PATCH /health`.
 *
 * HTTP requires a 405 response to include an `Allow` header listing what *is*
 * permitted, so this error carries the list and the error handler turns it into
 * that header. Errors being able to influence response headers is a nice
 * illustration of why the error handler needs access to the whole context.
 */
export class MethodNotAllowedError extends HttpError {
  /** The methods that this URL does accept. */
  readonly allowed: readonly string[];

  constructor(allowed: readonly string[]) {
    super(
      405,
      'METHOD_NOT_ALLOWED',
      `This URL does not support that method. Allowed methods: ${allowed.join(', ')}.`,
    );
    this.allowed = allowed;
  }
}

/**
 * 413 Content Too Large.
 *
 * The body exceeded `MAX_BODY_BYTES`. We check this both from the announced
 * `Content-Length` header and while streaming, because a client is free to lie
 * about (or omit) the length.
 */
export class PayloadTooLargeError extends HttpError {
  constructor(maxBytes: number) {
    super(
      413,
      'PAYLOAD_TOO_LARGE',
      `The request body is larger than the ${maxBytes} byte limit.`,
    );
  }
}

/**
 * 415 Unsupported Media Type.
 *
 * We got a body, but not one we know how to read. Since this API only speaks
 * JSON, that means a missing or non-JSON `Content-Type` header.
 */
export class UnsupportedMediaTypeError extends HttpError {
  constructor(message: string) {
    super(415, 'UNSUPPORTED_MEDIA_TYPE', message);
  }
}

/**
 * 422 Unprocessable Entity.
 *
 * The opposite of 400 in an important way: the request was *perfectly well
 * formed* -- valid JSON with a `Content-Type` we accept -- but the data inside it
 * does not satisfy our rules. A task with an empty title is the classic example.
 *
 * The distinction is worth internalising:
 *   400 -> "I could not understand the request."
 *   422 -> "I understood the request, and it is not acceptable."
 *
 * `details` is typed as `readonly unknown[]` so callers can pass a list of
 * validation issues without casting.
 */
export class UnprocessableEntityError extends HttpError {
  constructor(message: string, details?: readonly unknown[]) {
    super(422, 'VALIDATION_FAILED', message, details);
  }
}

/**
 * 500 Internal Server Error.
 *
 * A bug, or a dependency that failed. The `message` sent to the client is
 * deliberately generic: internal error messages routinely contain file paths,
 * SQL fragments and library internals, and handing those to the internet is a
 * security problem. The real error is logged on the server instead -- see
 * `middleware/errorHandler.ts`.
 */
export class InternalServerError extends HttpError {
  constructor(message = 'An unexpected internal error occurred.') {
    super(500, 'INTERNAL_ERROR', message);
  }
}
