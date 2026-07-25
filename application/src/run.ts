/**
 * Single CLI entry point for all three role clients — owner: person 4.
 *
 *   npm run cli -- producer    register --quantity 400
 *   npm run cli -- transporter transfer --batch BATCH-123 --to Org2MSP
 *   npm run cli -- regulator   history  --batch BATCH-123
 *
 * One entry point rather than three binaries: the role is the first argument,
 * which keeps the demo script readable and means a marker has one command to
 * remember. The role still selects a different signing identity, so this is a
 * shared front door, not a shared identity.
 */

import { ParsedCommand, hasFlag, parseArgs } from './args';
import { describeFailure, isPolicyRejection } from './errors';
import { runProducer } from './producer';
import { runRegulator } from './regulator';
import { runTransporter } from './transporter';
import { USAGE } from './usage';

type RoleHandler = (parsed: ParsedCommand, print: (line: string) => void) => Promise<void>;

export const HANDLERS: Readonly<Record<string, RoleHandler>> = {
  producer: runProducer,
  transporter: runTransporter,
  regulator: runRegulator,
};

/** Resolve the handler for a role, with an error that lists the alternatives. */
export const handlerFor = (role: string): RoleHandler => {
  const handler = HANDLERS[role];
  if (handler === undefined) {
    throw new Error(
      `unknown role '${role}'; expected one of: ${Object.keys(HANDLERS).join(', ')}`,
    );
  }
  return handler;
};

/** True when the invocation is asking for help rather than for work. */
export const wantsHelp = (parsed: ParsedCommand): boolean =>
  hasFlag(parsed, 'help') || parsed.role === 'help' || parsed.role === '';

/**
 * Human-readable clause naming what was attempted, used by the error
 * translation to build a sentence ("a transporter cannot register a batch").
 */
export const contextFor = (parsed: ParsedCommand): string => {
  switch (`${parsed.role} ${parsed.command}`) {
    case 'producer register':
    case 'transporter register':
      return 'register a batch';
    case 'producer report':
      return 'file an inspection report';
    case 'transporter transfer':
      return 'transfer custody of this batch';
    case 'transporter log':
      return 'log an in-transit event';
    case 'regulator flag':
      return 'flag this batch';
    case 'regulator recall':
      return 'recall this batch';
    case 'regulator history':
      return 'read this batch history';
    case 'regulator holdings':
      return 'list holdings';
    default:
      return `run ${parsed.role} ${parsed.command}`;
  }
};

export interface RunResult {
  /** Process exit code. */
  readonly code: number;
}

/**
 * Run one CLI invocation.
 *
 * Returns an exit code rather than calling `process.exit`, so the whole flow —
 * including the failure paths the demo depends on — is exercisable from a
 * test and from the demo script without tearing down the process.
 *
 * `--expect-rejection` inverts the outcome for the steps that are supposed to
 * be refused: a policy rejection becomes a success and, more importantly, an
 * unexpected SUCCESS becomes a failure. A demo step asserting "the network
 * refuses this" is worthless if it passes when the network allows it.
 */
export const run = async (
  argv: readonly string[],
  print: (line: string) => void = console.log,
  printError: (line: string) => void = console.error,
): Promise<RunResult> => {
  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    printError('');
    printError(USAGE);
    return { code: 2 };
  }

  if (wantsHelp(parsed)) {
    print(USAGE);
    return { code: 0 };
  }

  const expectRejection = hasFlag(parsed, 'expect-rejection');

  try {
    const handler = handlerFor(parsed.role);
    await handler(parsed, print);
  } catch (error) {
    const rendered = describeFailure(error, contextFor(parsed));

    if (expectRejection && isPolicyRejection(error)) {
      // Printed on stdout, not stderr: this is the demo working as intended.
      print(rendered);
      print('  (this rejection is the expected outcome — access control is doing its job)');
      return { code: 0 };
    }

    printError(rendered);
    return { code: 1 };
  }

  if (expectRejection) {
    printError(
      '  SECURITY FAILURE: the transaction was expected to be refused but the network ' +
        'accepted it',
    );
    return { code: 1 };
  }

  return { code: 0 };
};

// `require.main === module` keeps this importable by the tests without the CLI
// firing as a side effect of the import.
if (require.main === module) {
  run(process.argv.slice(2))
    .then(({ code }) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // Anything reaching here is a bug in the error handling above, not a
      // network rejection, so it is worth showing in full.
      console.error('client crashed:', error);
      process.exitCode = 1;
    });
}
