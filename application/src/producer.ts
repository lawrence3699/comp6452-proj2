/**
 * Producer client — owner: person 4.
 *
 * Signs as `producer1`, whose certificate carries `role=producer`. That is the
 * only identity `RegisterBatch` accepts, so the access control is real rather
 * than advisory: pointing this command at any other certificate makes the
 * endorsing peers refuse it.
 */

import { GatewayConnection } from '@comp6452/offchain-shared';
import { getJson, putJson } from '@comp6452/offchain-storage';
import { ParsedCommand, hasFlag, numberOption, option, requireOption } from './args';
import { asRole, decodeJson, registryContract } from './client';
import { Batch, formatBatch, generateBatchId, section, shortHash, step } from './format';

/** Fields written to the public ledger by `RegisterBatch`. */
export interface RegisterInput {
  readonly batchId: string;
  readonly foodType: string;
  readonly producedAt: number;
  readonly shelfLifeDays: number;
  readonly origin: string;
  readonly quantity: number;
  /** Parent batch, when this one was repacked or split from another. */
  readonly derivedFrom?: string;
  /** Anchor for the inspection report held in off-chain storage. */
  readonly reportHash?: string;
}

/**
 * Commercially sensitive fields. These never appear in `RegisterInput`: they
 * travel in the transient map and land in the `batchPrivateDetails`
 * collection, so only the collection's member organisations ever hold the
 * values while every peer still holds their hash.
 */
export interface PrivateDetails {
  readonly unitPrice: number;
  readonly inspectionNotes: string;
}

/** Transient-map key expected by `chaincode/batch-registry/src/privateData.ts`. */
export const TRANSIENT_KEY = 'batch_private_details';

/**
 * Build the registration payload, defaulting what can sensibly be defaulted.
 *
 * Pure, so the argument handling is unit tested without a network. `producedAt`
 * defaults to now because the chaincode rejects a future timestamp and a demo
 * that hard-coded a date would start failing the moment the clock passed it.
 */
export const buildRegisterInput = (
  parsed: ParsedCommand,
  now: number = Date.now(),
): RegisterInput => {
  const batchId = option(parsed, 'batch') ?? generateBatchId('BATCH', now);
  const derivedFrom = option(parsed, 'derived-from');
  const reportHash = option(parsed, 'report-hash');

  const input: RegisterInput = {
    batchId,
    foodType: option(parsed, 'food-type', 'chilled'),
    producedAt: numberOption(parsed, 'produced-at', Math.trunc(now / 1000)),
    shelfLifeDays: numberOption(parsed, 'shelf-life', 14),
    origin: option(parsed, 'origin', 'Riverina NSW'),
    quantity: numberOption(parsed, 'quantity', 500),
    ...(derivedFrom !== undefined ? { derivedFrom } : {}),
    ...(reportHash !== undefined ? { reportHash } : {}),
  };

  if (input.quantity <= 0) {
    throw new Error('--quantity must be greater than zero');
  }
  if (input.shelfLifeDays <= 0) {
    throw new Error('--shelf-life must be greater than zero');
  }
  return input;
};

/** Build the transient payload, or undefined when the caller opted out. */
export const buildPrivateDetails = (parsed: ParsedCommand): PrivateDetails | undefined => {
  if (hasFlag(parsed, 'no-private')) {
    return undefined;
  }
  return {
    unitPrice: numberOption(parsed, 'unit-price', 4.5),
    inspectionNotes: option(parsed, 'inspection-notes', 'Chilled at 2C on despatch; seals intact.'),
  };
};

/**
 * Submit `RegisterBatch`.
 *
 * The private payload goes through `transientData`, never through `arguments`.
 * A normal argument is recorded verbatim in the transaction proposal and ends
 * up readable on every peer's ledger, which would defeat the entire reason for
 * having a private data collection.
 */
export const registerBatch = async (
  connection: GatewayConnection,
  input: RegisterInput,
  privateDetails?: PrivateDetails,
): Promise<string> => {
  const contract = registryContract(connection);
  const proposal = contract.newProposal('RegisterBatch', {
    arguments: [JSON.stringify(input)],
    ...(privateDetails !== undefined
      ? { transientData: { [TRANSIENT_KEY]: JSON.stringify(privateDetails) } }
      : {}),
  });

  const transaction = await proposal.endorse();
  const commit = await transaction.submit();
  const status = await commit.getStatus();
  if (!status.successful) {
    throw new Error(
      `RegisterBatch for ${input.batchId} did not commit: status code ${String(status.code)}`,
    );
  }
  return commit.getTransactionId();
};

/**
 * Store an inspection report off chain and return its content hash.
 *
 * Only the hash is anchored on the ledger (`Batch.reportHash`). The report body
 * — which in a real deployment is a signed PDF and photographs — stays in the
 * content-addressed store, so the chain carries tamper-evidence rather than
 * bulk data.
 */
export const storeInspectionReport = async (
  batchId: string,
  inspector: string,
  findings: string,
): Promise<string> => {
  const stored = await putJson({
    schema: 'comp6452.inspection-report.v1',
    batchId,
    inspector,
    findings,
    issuedAt: new Date().toISOString(),
  });
  return stored.hash;
};

const readBatch = async (connection: GatewayConnection, batchId: string): Promise<Batch> =>
  decodeJson<Batch>(await registryContract(connection).evaluateTransaction('GetBatch', batchId));

/** `producer register` — the FR1 write path, with private details attached. */
const commandRegister = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const identity = option(parsed, 'as');

  // The report is stored before the transaction so its hash can be anchored in
  // the same registration rather than needing a second write.
  const attachReport = !hasFlag(parsed, 'no-report');
  const draft = buildRegisterInput(parsed);
  const reportHash = attachReport
    ? await storeInspectionReport(
        draft.batchId,
        option(parsed, 'inspector', 'NSW Food Authority, inspector 447'),
        option(parsed, 'findings', 'Cold room at 2C, packaging intact, no visible spoilage.'),
      )
    : draft.reportHash;

  const input: RegisterInput = { ...draft, ...(reportHash !== undefined ? { reportHash } : {}) };
  const privateDetails = buildPrivateDetails(parsed);

  print(section(`PRODUCER registers batch ${input.batchId}`));
  print(step(`signing as ${identity ?? 'producer1'} (role=producer, issued by Fabric CA)`));
  if (reportHash !== undefined) {
    print(step(`inspection report stored off chain, anchoring hash ${shortHash(reportHash, 16)}`));
  }
  if (privateDetails !== undefined) {
    print(
      step(
        `private details (unit price ${String(privateDetails.unitPrice)}) sent via the transient ` +
          'map into collection batchPrivateDetails',
      ),
    );
  }

  await asRole('producer', identity, async (connection) => {
    const txId = await registerBatch(connection, input, privateDetails);
    print(step(`committed in transaction ${shortHash(txId, 16)}`));
    print('');
    print(formatBatch(await readBatch(connection, input.batchId)));
    if (privateDetails !== undefined) {
      print('');
      print(
        step(
          'note that the public record above carries no unit price and no inspection notes — ' +
            'those exist only in the private collection',
        ),
      );
    }
  });
};

/** Inspection report as stored off chain. */
export interface InspectionReport {
  readonly schema: string;
  readonly batchId: string;
  readonly inspector: string;
  readonly findings: string;
  readonly issuedAt: string;
}

/**
 * `producer report` — resolve the report hash anchored on the ledger back to
 * the report body, and check it still hashes to the anchored value.
 *
 * This is the other half of the off-chain-storage story and the reason the
 * hash is on the ledger at all: the chain is not holding the document, it is
 * holding the proof that this document is the one that was filed. `getJson`
 * re-hashes before returning, so reaching the end of this command without
 * throwing is the verification.
 */
const commandReport = async (parsed: ParsedCommand, print: (line: string) => void): Promise<void> => {
  const batchId = requireOption(parsed, 'batch');
  const identity = option(parsed, 'as');

  print(section(`PRODUCER verifies the inspection report for ${batchId}`));

  await asRole('producer', identity, async (connection) => {
    const batch = await readBatch(connection, batchId);
    print(step(`batch is ${batch.status}, held by ${batch.currentHolder}`));

    if (batch.reportHash === '') {
      // Not a failure: a batch may legitimately have been registered without
      // one. Saying so is more useful than throwing.
      print(step('no inspection report is anchored on this batch'));
      return;
    }

    print(step(`ledger anchors report hash ${batch.reportHash}`));
    const report = await getJson<InspectionReport>(batch.reportHash);
    print(step('fetched the report from off-chain storage and re-hashed it: MATCHES the anchor'));
    print('');
    print(`  inspector     ${report.inspector}`);
    print(`  issued at     ${report.issuedAt}`);
    print(`  findings      ${report.findings}`);
    print('');
    print(
      step(
        'the ledger holds only the 32-byte hash — the document itself never touched the chain, ' +
          'but altering it by one character would break this check',
      ),
    );
  });
};

export const runProducer = async (
  parsed: ParsedCommand,
  print: (line: string) => void = console.log,
): Promise<void> => {
  switch (parsed.command) {
    case 'register':
      return commandRegister(parsed, print);
    case 'report':
      return commandReport(parsed, print);
    default:
      throw new Error(
        `unknown producer command '${parsed.command}'; expected one of: register, report`,
      );
  }
};
