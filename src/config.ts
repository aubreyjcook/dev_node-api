/**
 * Application configuration, read once at startup from environment variables.
 *
 * Why environment variables instead of a config file?
 *   - The same code can run locally, in CI and in production with no edits.
 *   - Secrets never end up in git.
 *   - Processes are told how to behave by whoever launches them, which is how
 *     containers and process managers normally work.
 *
 * Node loads a `.env` file for us because the npm scripts pass
 * `--env-file-if-exists=.env`. Copy `.env.example` to `.env` to use it.
 *
 * Everything is validated and converted to its real type *here*, once. That is
 * why the `AppConfig` interface below has `port: number` rather than
 * `port: string`: `process.env.PORT` is always a string, and spreading that
 * string-typed mess through the codebase is a common source of bugs.
 */

/**
 * The validated configuration. `readonly` because configuration is decided at
 * startup and nothing should be able to change it halfway through a request.
 */
export interface AppConfig {
  readonly nodeEnv: string;
  readonly host: string;
  readonly port: number;
  readonly corsOrigin: string;
  readonly maxBodyBytes: number;
  readonly logRequests: boolean;
  readonly seedData: boolean;
}

/**
 * Read a string setting, treating an empty value as "not set".
 *
 * `process.env.SOMETHING` is typed `string | undefined` -- a variable that is
 * simply absent is `undefined`, never `''`. Empty strings do show up in practice
 * though (for example `PORT=` in a `.env` file), and those almost always mean
 * "I did not set this", so we normalise them to the fallback as well.
 */
function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

/**
 * Read a whole-number setting.
 *
 * Failing loudly at startup is the point. A typo like `PORT=three-thousand`
 * should stop the process immediately with a clear message, not produce a server
 * that mysteriously listens on the wrong port (or `NaN`).
 */
function readInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  // `Number(...)` rather than `parseInt(...)`: parseInt('3000abc') happily
  // returns 3000, which would hide the typo. Number() returns NaN instead.
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Invalid environment variable ${name}: expected a whole number between ${minimum} and ${maximum}, but received "${raw}".`,
    );
  }
  return parsed;
}

/**
 * Read a boolean setting.
 *
 * Only the values people actually type are accepted. Anything else is an error,
 * because silently falling back to a default when someone writes `LOG_REQUESTS=yes`
 * is exactly the kind of quiet surprise that wastes an afternoon.
 */
function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  switch (raw.trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
      return true;
    case 'false':
    case '0':
    case 'no':
      return false;
    default:
      throw new Error(
        `Invalid environment variable ${name}: expected one of true/false/1/0/yes/no, but received "${raw}".`,
      );
  }
}

/**
 * The one and only configuration object.
 *
 * This module runs once, the first time anything imports it, and the exports are
 * then cached by Node's module system. So this object is built exactly once per
 * process, no matter how many files import it.
 */
export const config: AppConfig = {
  nodeEnv: readString('NODE_ENV', 'development'),
  host: readString('HOST', '127.0.0.1'),
  // Port 0 is allowed on purpose: it means "operating system, pick any free
  // port for me", which is what the automated tests use.
  port: readInteger('PORT', 3000, 0, 65_535),
  corsOrigin: readString('CORS_ORIGIN', '*'),
  maxBodyBytes: readInteger('MAX_BODY_BYTES', 100_000, 1, 100_000_000),
  logRequests: readBoolean('LOG_REQUESTS', true),
  seedData: readBoolean('SEED_DATA', true),
};
