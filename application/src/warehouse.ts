/**
 * Warehouse client — owner: person 4.
 *
 * Signs as `warehouse1`. Like `TransferCustody`, `MarkDelivered` checks
 * possession rather than a job title: the caller's MSP must equal the batch's
 * `currentHolder`. `warehouse1` is enrolled with Org1's CA, so this client can
 * only close out batches that Org1MSP is holding — which is exactly the rule
 * a real receiving dock would want, since declaring goods delivered that your
 * organisation does not hold would be fraud, not workflow.
 *
 * The state machine does the other half of the guard: only AT_WAREHOUSE may
 * move to DELIVERED, so a batch still on the road cannot be closed early no
 * matter who signs.
 */

import { GatewayConnection } from '@comp6452/offchain-shared';
import { ParsedCommand, option, requireOption } from './args';
import { asRole, decodeJson, registryContract } from './client';
import { Batch, formatBatch, formatBatchLine, section, shortHash, step } from './format';

const readBatch = async (connection: GatewayConnection, batchId: string): Promise<Batch> =>
  decodeJson<Batch>(await registryContract(connection).evaluateTransaction('GetBatch', batchId));

/**
 * Submit `MarkDelivered`.
 *
 * DELIVERED is the successful terminus of the custody chain — the counterpart
 * to RECALLED on the failure side. The chaincode leaves the holder index
 * alone, so the delivering organisation keeps the batch in its holdings view;
 * delivery ends the journey, not possession.
 */
export const markDelivered = async (
  connection: GatewayConnection,
  batchId: string,
): Promise<string> => {
  const proposal = registryContract(connection).newProposal('MarkDelivered', {
    arguments: [batchId],
  });
  const transaction = await proposal.endorse();
  const commit = await transaction.submit();
  const status = await commit.getStatus();
  if (!status.successful) {
    throw new Error(
      `MarkDelivered of ${batchId} did not commit: status code ${String(status.code)}`,
    );
  }
  return commit.getTransactionId();
};

/** `warehouse deliver` — close out the custody chain at the receiving dock. */
const commandDeliver = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const batchId = requireOption(parsed, 'batch');
  const identity = option(parsed, 'as');

  print(section(`WAREHOUSE marks ${batchId} as delivered`));
  print(step(`signing as ${identity ?? 'warehouse1'} (role=warehouse)`));

  await asRole('warehouse', identity, async (connection) => {
    const before = await readBatch(connection, batchId);
    print(step(`before: ${formatBatchLine(before)}`));

    const txId = await markDelivered(connection, batchId);
    print(step(`committed in transaction ${shortHash(txId, 16)}`));

    // Re-read rather than assume: the status printed here is what the ledger
    // committed, not what this client hoped for.
    const after = await readBatch(connection, batchId);
    print(step(`after:  ${formatBatchLine(after)}`));
    print(
      step(
        `status moved ${before.status} -> ${after.status}; only AT_WAREHOUSE may make ` +
          'this move, enforced by the on-chain state machine',
      ),
    );
  });
};

/** `warehouse show` — what does this batch look like right now. */
const commandShow = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const batchId = requireOption(parsed, 'batch');
  const identity = option(parsed, 'as');

  print(section(`WAREHOUSE reads ${batchId}`));
  await asRole('warehouse', identity, async (connection) => {
    print(formatBatch(await readBatch(connection, batchId)));
  });
};

export const runWarehouse = async (
  parsed: ParsedCommand,
  print: (line: string) => void = console.log,
): Promise<void> => {
  switch (parsed.command) {
    case 'deliver':
      return commandDeliver(parsed, print);
    case 'show':
      return commandShow(parsed, print);
    default:
      throw new Error(
        `unknown warehouse command '${parsed.command}'; expected one of: deliver, show`,
      );
  }
};
