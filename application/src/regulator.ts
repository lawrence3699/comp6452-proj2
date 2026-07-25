/**
 * Regulator client — owner: person 4.
 *
 * Signs as `regulator1` (`role=regulator`). This is the identity with the
 * enforcement powers — flag and recall — and the one that reads the whole
 * traceability trail back, which is the FR2 deliverable.
 *
 * Flag and recall go through `coldchain-compliance` rather than straight to
 * `batch-registry`. Both routes exist on chain, but the compliance chaincode
 * is the one that cascades a recall down the derivation graph, so a regulator
 * recalling a pallet also recalls the cases repacked from it. Going direct
 * would silently recall only the pallet — `--direct` exists to demonstrate the
 * difference, not as the recommended path.
 */

import { GatewayConnection } from '@comp6452/offchain-shared';
import { ParsedCommand, hasFlag, option, requireOption } from './args';
import {
  asRole,
  complianceContract,
  decodeJson,
  decodeText,
  queryContract,
  registryContract,
} from './client';
import {
  Batch,
  HistoryEntry,
  StoredReading,
  formatBatch,
  formatHistory,
  formatHolderInventory,
  formatReadings,
  section,
  shortHash,
  step,
} from './format';

const readBatch = async (connection: GatewayConnection, batchId: string): Promise<Batch> =>
  decodeJson<Batch>(await registryContract(connection).evaluateTransaction('GetBatch', batchId));

/** Submit a transaction and return its id, failing loudly on a bad commit. */
const submitOn = async (
  contractOf: (connection: GatewayConnection) => ReturnType<typeof registryContract>,
  connection: GatewayConnection,
  name: string,
  args: readonly string[],
): Promise<{ readonly txId: string; readonly result: Uint8Array }> => {
  const proposal = contractOf(connection).newProposal(name, { arguments: [...args] });
  const transaction = await proposal.endorse();
  const commit = await transaction.submit();
  const status = await commit.getStatus();
  if (!status.successful) {
    throw new Error(`${name} did not commit: status code ${String(status.code)}`);
  }
  return { txId: commit.getTransactionId(), result: transaction.getResult() };
};

/** Flag a batch. Through compliance by default, or straight at the registry. */
export const flagBatch = async (
  connection: GatewayConnection,
  batchId: string,
  reason: string,
  evidenceHash: string,
  direct: boolean,
): Promise<string> => {
  const { txId } = direct
    ? await submitOn(registryContract, connection, 'FlagBatch', [batchId, reason, evidenceHash])
    : await submitOn(complianceContract, connection, 'FlagByRegulator', [
        batchId,
        reason,
        evidenceHash,
      ]);
  return txId;
};

/**
 * Recall a batch. Through compliance the recall cascades to every batch
 * derived from this one and the ids come back as JSON; direct at the registry
 * it touches only the named batch.
 */
export const recallBatch = async (
  connection: GatewayConnection,
  batchId: string,
  direct: boolean,
): Promise<{ readonly txId: string; readonly recalled: readonly string[] }> => {
  if (direct) {
    const { txId } = await submitOn(registryContract, connection, 'RecallBatch', [batchId]);
    return { txId, recalled: [batchId] };
  }
  const { txId, result } = await submitOn(complianceContract, connection, 'RecallBatch', [batchId]);
  const payload = decodeText(result);
  // The cascade returns its blast radius as JSON; an empty payload would mean
  // the chaincode answered without saying what it touched, which is worth
  // reporting rather than silently rendering as "nothing was recalled".
  const recalled = payload === '' ? [] : (JSON.parse(payload) as string[]);
  return { txId, recalled };
};

/** `regulator history` — the FR2 traceability read-back. */
const commandHistory = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const batchId = requireOption(parsed, 'batch');
  const identity = option(parsed, 'as');

  print(section(`REGULATOR reads the full traceability history of ${batchId}`));
  print(step(`signing as ${identity ?? 'regulator1'} (role=regulator)`));

  await asRole('regulator', identity, async (connection) => {
    const batch = await readBatch(connection, batchId);
    print('');
    print(formatBatch(batch));

    const entries = decodeJson<HistoryEntry[]>(
      await queryContract(connection).evaluateTransaction('GetBatchHistory', batchId),
    );
    print('');
    print(`  custody trail — every committed version of this key, oldest first:`);
    print(formatHistory(entries));

    // The readings are the evidence behind whatever the status now says. A
    // regulator who can see FLAGGED but not why would have to take it on trust.
    const readings = decodeJson<StoredReading[]>(
      await complianceContract(connection).evaluateTransaction('GetReadings', batchId),
    );
    print('');
    print('  temperature readings submitted by the oracle:');
    print(formatReadings(readings));

    const breachCount = decodeText(
      await complianceContract(connection).evaluateTransaction('GetBreachCount', batchId),
    );
    print('');
    print(step(`consecutive breach counter now stands at ${breachCount}`));
    print(
      step(
        `${String(entries.length)} ledger version(s) recovered — this trail is append-only, ` +
          'so nobody can rewrite where the batch has been',
      ),
    );
  });
};

/** `regulator holdings` — everything an MSP is currently holding. */
const commandHoldings = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const holder = option(parsed, 'holder', 'Org1MSP');
  const identity = option(parsed, 'as');

  print(section(`REGULATOR lists the batches held by ${holder}`));

  await asRole('regulator', identity, async (connection) => {
    const batches = decodeJson<Batch[]>(
      await queryContract(connection).evaluateTransaction('GetBatchesByHolder', holder),
    );
    print(formatHolderInventory(holder, batches));
    print('');
    print(
      step(
        'served from a holder~batchId composite-key index, so this is a range scan ' +
          'rather than a full ledger walk',
      ),
    );
  });
};

/** `regulator flag` — mark a batch as a problem on the human-decision path. */
const commandFlag = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const batchId = requireOption(parsed, 'batch');
  const identity = option(parsed, 'as');
  const direct = hasFlag(parsed, 'direct');
  const reason = option(parsed, 'reason', 'Regulator inspection: cold chain integrity in doubt.');
  const evidenceHash = option(parsed, 'evidence', '');

  print(section(`REGULATOR flags ${batchId}`));
  print(step(`route: ${direct ? 'batch-registry directly' : 'coldchain-compliance -> batch-registry'}`));
  print(step(`reason: ${reason}`));

  await asRole('regulator', identity, async (connection) => {
    const txId = await flagBatch(connection, batchId, reason, evidenceHash, direct);
    print(step(`committed in transaction ${shortHash(txId, 16)}`));
    const after = await readBatch(connection, batchId);
    print(step(`batch is now ${after.status}`));
  });
};

/** `regulator recall` — withdraw a flagged batch and everything derived from it. */
const commandRecall = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const batchId = requireOption(parsed, 'batch');
  const identity = option(parsed, 'as');
  const direct = hasFlag(parsed, 'direct');

  print(section(`REGULATOR recalls ${batchId}`));
  print(
    step(
      direct
        ? 'route: batch-registry directly (this batch only, no cascade)'
        : 'route: coldchain-compliance, which cascades to every batch derived from this one',
    ),
  );

  await asRole('regulator', identity, async (connection) => {
    const { txId, recalled } = await recallBatch(connection, batchId, direct);
    print(step(`committed in transaction ${shortHash(txId, 16)}`));
    print(
      step(
        recalled.length === 0
          ? 'the chaincode reported no recalled ids'
          : `recalled ${String(recalled.length)} batch(es): ${recalled.join(', ')}`,
      ),
    );
    const after = await readBatch(connection, batchId);
    print(step(`batch is now ${after.status}`));
  });
};

/** `regulator show` — one batch, no history. */
const commandShow = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const batchId = requireOption(parsed, 'batch');
  const identity = option(parsed, 'as');

  print(section(`REGULATOR reads ${batchId}`));
  await asRole('regulator', identity, async (connection) => {
    print(formatBatch(await readBatch(connection, batchId)));
  });
};

export const runRegulator = async (
  parsed: ParsedCommand,
  print: (line: string) => void = console.log,
): Promise<void> => {
  switch (parsed.command) {
    case 'history':
      return commandHistory(parsed, print);
    case 'holdings':
      return commandHoldings(parsed, print);
    case 'flag':
      return commandFlag(parsed, print);
    case 'recall':
      return commandRecall(parsed, print);
    case 'show':
      return commandShow(parsed, print);
    default:
      throw new Error(
        `unknown regulator command '${parsed.command}'; ` +
          'expected one of: history, holdings, flag, recall, show',
      );
  }
};
