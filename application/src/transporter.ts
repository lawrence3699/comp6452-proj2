/**
 * Transporter client — owner: person 4.
 *
 * Signs as `transporter1`. Note what the chaincode does and does not check on
 * this path: `TransferCustody` does NOT require a role attribute, it requires
 * that the caller's MSP is the batch's current holder. That is the right rule
 * — custody is about who physically has the goods, not about job title — and
 * it is why this client can move a batch that the producer registered: both
 * identities belong to Org1MSP, so the org holding the batch is the org
 * signing the transfer.
 *
 * The demo makes the distinction visible by having this same client try to
 * register a batch, which the peers refuse, and by having a non-holder attempt
 * a transfer, which they also refuse.
 */

import { GatewayConnection } from '@comp6452/offchain-shared';
import { putJson } from '@comp6452/offchain-storage';
import { ParsedCommand, option, requireOption } from './args';
import { asRole, decodeJson, registryContract } from './client';
import { Batch, formatBatch, formatBatchLine, section, shortHash, step } from './format';

/** An in-transit observation, stored off chain and anchored by hash. */
export interface TransitEvent {
  readonly schema: string;
  readonly batchId: string;
  readonly carrier: string;
  readonly location: string;
  readonly note: string;
  readonly recordedAt: string;
}

const readBatch = async (connection: GatewayConnection, batchId: string): Promise<Batch> =>
  decodeJson<Batch>(await registryContract(connection).evaluateTransaction('GetBatch', batchId));

/**
 * Submit `TransferCustody`.
 *
 * `toMsp` is an MSP id (Org1MSP / Org2MSP), not a user name: custody is held
 * by an organisation, because that is the unit the endorsement policy and the
 * private data collection are written in terms of.
 */
export const transferCustody = async (
  connection: GatewayConnection,
  batchId: string,
  toMsp: string,
): Promise<string> => {
  const proposal = registryContract(connection).newProposal('TransferCustody', {
    arguments: [batchId, toMsp],
  });
  const transaction = await proposal.endorse();
  const commit = await transaction.submit();
  const status = await commit.getStatus();
  if (!status.successful) {
    throw new Error(
      `TransferCustody of ${batchId} did not commit: status code ${String(status.code)}`,
    );
  }
  return commit.getTransactionId();
};

/**
 * Record an in-transit observation off chain and return its anchor.
 *
 * Every leg of a journey produces GPS traces, door-open events and driver
 * notes. Writing that volume on chain would bloat every peer's ledger for data
 * nobody disputes; storing it content-addressed and anchoring the hash keeps
 * it tamper-evident at a constant 32 bytes.
 */
export const logTransitEvent = async (
  batchId: string,
  carrier: string,
  location: string,
  note: string,
): Promise<{ readonly hash: string; readonly event: TransitEvent }> => {
  const event: TransitEvent = {
    schema: 'comp6452.transit-event.v1',
    batchId,
    carrier,
    location,
    note,
    recordedAt: new Date().toISOString(),
  };
  const stored = await putJson(event);
  return { hash: stored.hash, event };
};

/** `transporter transfer` — hand the batch to another organisation. */
const commandTransfer = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const batchId = requireOption(parsed, 'batch');
  const toMsp = requireOption(parsed, 'to');
  const identity = option(parsed, 'as');

  print(section(`TRANSPORTER moves ${batchId} to ${toMsp}`));
  print(step(`signing as ${identity ?? 'transporter1'} (role=transporter)`));

  await asRole('transporter', identity, async (connection) => {
    const before = await readBatch(connection, batchId);
    print(step(`before: ${formatBatchLine(before)}`));

    const txId = await transferCustody(connection, batchId, toMsp);
    print(step(`committed in transaction ${shortHash(txId, 16)}`));

    const after = await readBatch(connection, batchId);
    print(step(`after:  ${formatBatchLine(after)}`));
    print(
      step(
        `status moved ${before.status} -> ${after.status}, enforced by the on-chain state machine`,
      ),
    );
  });
};

/** `transporter log` — record an in-transit observation against the batch. */
const commandLog = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const batchId = requireOption(parsed, 'batch');
  const identity = option(parsed, 'as');

  print(section(`TRANSPORTER logs an in-transit event for ${batchId}`));

  await asRole('transporter', identity, async (connection) => {
    // Read first: logging an event against a batch that does not exist, or
    // that this carrier is not holding, would produce evidence nobody can tie
    // back to the ledger.
    const batch = await readBatch(connection, batchId);
    print(step(`batch is ${batch.status}, held by ${batch.currentHolder}`));

    const { hash, event } = await logTransitEvent(
      batchId,
      option(parsed, 'carrier', 'ColdRun Logistics, truck CR-118'),
      option(parsed, 'location', 'Hume Highway, Goulburn NSW'),
      option(parsed, 'note', 'Reefer set to 2C, doors sealed, on schedule.'),
    );

    print(step(`stored off chain, content hash ${hash}`));
    print('');
    print(`  carrier       ${event.carrier}`);
    print(`  location      ${event.location}`);
    print(`  recorded at   ${event.recordedAt}`);
    print(`  note          ${event.note}`);
    print('');
    print(
      step(
        'high-volume telemetry stays off chain; the ledger carries the custody transfer ' +
          'and the oracle summary that reference it',
      ),
    );
  });
};

/** `transporter show` — what does this batch look like right now. */
const commandShow = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const batchId = requireOption(parsed, 'batch');
  const identity = option(parsed, 'as');

  print(section(`TRANSPORTER reads ${batchId}`));
  await asRole('transporter', identity, async (connection) => {
    print(formatBatch(await readBatch(connection, batchId)));
  });
};

/**
 * `transporter register` — deliberately illegal, kept as a first-class command.
 *
 * The demo needs to show access control taking effect, and it is more honest
 * to do that with the transporter client genuinely attempting a producer-only
 * transaction than with a special-cased script step.
 */
const commandRegister = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const batchId = option(parsed, 'batch', 'TRANSPORTER-ATTEMPT');
  const identity = option(parsed, 'as');

  print(section('TRANSPORTER attempts to register a batch (this must fail)'));
  print(step(`signing as ${identity ?? 'transporter1'} (role=transporter, NOT producer)`));

  await asRole('transporter', identity, async (connection) => {
    const proposal = registryContract(connection).newProposal('RegisterBatch', {
      arguments: [
        JSON.stringify({
          batchId,
          foodType: 'chilled',
          producedAt: Math.trunc(Date.now() / 1000),
          shelfLifeDays: 14,
          origin: 'nowhere',
          quantity: 1,
        }),
      ],
    });
    // Endorsement is where the role check runs, so this throws before anything
    // reaches the orderer: the transaction never becomes a ledger entry at all.
    const transaction = await proposal.endorse();
    await (await transaction.submit()).getStatus();
    throw new Error(
      'SECURITY FAILURE: a transporter was allowed to register a batch — the role check did not run',
    );
  });
};

export const runTransporter = async (
  parsed: ParsedCommand,
  print: (line: string) => void = console.log,
): Promise<void> => {
  switch (parsed.command) {
    case 'transfer':
      return commandTransfer(parsed, print);
    case 'log':
      return commandLog(parsed, print);
    case 'show':
      return commandShow(parsed, print);
    case 'register':
      return commandRegister(parsed, print);
    default:
      throw new Error(
        `unknown transporter command '${parsed.command}'; ` +
          'expected one of: transfer, log, show, register',
      );
  }
};
