/**
 * Command-line parsing — owner: person 4.
 *
 * Pure: no I/O, no process.argv, no network. Everything the CLI decides about
 * its own invocation is decided here, which is why this file carries the unit
 * tests while the gateway paths do not. A marker running the demo never reads
 * this code, but a marker who mistypes an option gets its error messages.
 *
 * No third-party argument parser: the whole grammar is
 * `<role> <command> [--key value | --key=value | --flag]`, and pulling in
 * yargs to express that would add a dependency the assessment has to audit.
 */

/**
 * Options that never take a value. Without this list `--direct history` would
 * silently swallow `history` as the value of `--direct`, and the user would
 * get "missing command" instead of the thing they asked for.
 */
export const BOOLEAN_FLAGS: readonly string[] = [
  'direct',
  'json',
  'help',
  'no-private',
  'no-report',
  'expect-rejection',
];

export interface ParsedCommand {
  /** First positional: which client to act as. */
  readonly role: string;
  /** Second positional: which action that client should take. */
  readonly command: string;
  /** `--key value` pairs; boolean flags are stored as the string 'true'. */
  readonly options: Readonly<Record<string, string>>;
  /** Anything after the role and the command. */
  readonly positional: readonly string[];
}

const isOptionToken = (token: string): boolean => token.startsWith('--');

/**
 * Parse an argument vector (already stripped of `node` and the script path).
 *
 * A missing role or command becomes `help` rather than an error: running the
 * CLI with no arguments at all should print usage, not a stack trace.
 */
export const parseArgs = (argv: readonly string[]): ParsedCommand => {
  const options: Record<string, string> = {};
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '-h') {
      options.help = 'true';
      continue;
    }

    if (token === '--') {
      // Conventional end-of-options marker: everything after is positional,
      // which is how a batch id beginning with `--` could ever be passed.
      positional.push(...argv.slice(index + 1));
      break;
    }

    if (!isOptionToken(token)) {
      if (token.startsWith('-') && token.length > 1) {
        throw new Error(`unrecognised argument '${token}' (options are spelled --like-this)`);
      }
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf('=');

    if (equals >= 0) {
      const key = body.slice(0, equals);
      if (key === '') {
        throw new Error(`unrecognised argument '${token}'`);
      }
      options[key] = body.slice(equals + 1);
      continue;
    }

    if (body === '') {
      throw new Error(`unrecognised argument '${token}'`);
    }

    const next = argv[index + 1];
    if (BOOLEAN_FLAGS.includes(body) || next === undefined || isOptionToken(next)) {
      options[body] = 'true';
      continue;
    }

    options[body] = next;
    index += 1;
  }

  return {
    role: positional[0] ?? 'help',
    command: positional[1] ?? 'help',
    options,
    positional: positional.slice(2),
  };
};

/**
 * Read an option, or a fallback. An empty string counts as absent — a shell
 * that expands an unset variable produces `--origin ''`, and building a record
 * around "" is harder to debug than taking the default.
 *
 * Overloaded so that supplying a fallback narrows the result to `string`;
 * callers with a default then need no cast and no non-null assertion.
 */
export function option(parsed: ParsedCommand, name: string, fallback: string): string;
export function option(parsed: ParsedCommand, name: string): string | undefined;
export function option(
  parsed: ParsedCommand,
  name: string,
  fallback?: string,
): string | undefined {
  const value = parsed.options[name];
  if (value === undefined || value === '') {
    return fallback;
  }
  return value;
}

/**
 * Read an option that the command cannot run without. The error names the
 * option and the command, because "missing argument" alone sends the reader
 * back to the source — which the demo is supposed to make unnecessary.
 */
export const requireOption = (parsed: ParsedCommand, name: string): string => {
  const value = option(parsed, name);
  if (value === undefined) {
    throw new Error(
      `${parsed.role} ${parsed.command}: missing required option --${name}`,
    );
  }
  return value;
};

/** Read a numeric option, rejecting anything that is not a finite number. */
export const numberOption = (
  parsed: ParsedCommand,
  name: string,
  fallback?: number,
): number => {
  const raw = option(parsed, name);
  if (raw === undefined) {
    if (fallback === undefined) {
      throw new Error(`${parsed.role} ${parsed.command}: missing required option --${name}`);
    }
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} must be a number, got '${raw}'`);
  }
  return value;
};

/** True when a boolean flag was supplied. */
export const hasFlag = (parsed: ParsedCommand, name: string): boolean =>
  parsed.options[name] === 'true';
