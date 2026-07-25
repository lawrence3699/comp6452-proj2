/**
 * On-chain submission — owner: person 3.
 *
 * Everything that touches the network lives here so `summarise.ts` stays pure
 * and the unit tests need no Fabric. The oracle signs with the `oracle1`
 * identity (ABAC attribute `oracle=true`), which is the only identity
 * `SubmitTemperatureReading` accepts.
 */

import {
  FabricConfig,
  GatewayConnection,
  envOrDefault,
  getNetwork,
  loadConfig,
  withGateway,
} from '@comp6452/offchain-shared';
import { Summary, formatObservedAt, formatTempC, reportedStatFromEnv, reportedTempC } from './summarise';

/**
 * Both chaincodes register more than one contract, so a bare function name is
 * ambiguous and the peer rejects it. `getContract(chaincode, contract)` is the
 * gateway-side equivalent of the `Contract:Function` form used for
 * cross-chaincode invokes. Overridable because the contract name is the
 * chaincode class name, which is person 2's to choose.
 */
export const complianceContractName = (): string =>
  envOrDefault('COMPLIANCE_CONTRACT_NAME', 'ComplianceContract');

/**
 * Config for the oracle identity. `SubmitTemperatureReading` only accepts a
 * certificate carrying `oracle=true`, so the default identity is `oracle1`
 * (provisioned by person 4) rather than the generic User1 — FABRIC_USER still
 * wins if the caller sets it.
 */
export const oracleConfig = (overrides: Partial<FabricConfig> = {}): FabricConfig =>
  loadConfig(overrides, envOrDefault('ORACLE_USER', 'oracle1'));

const SHA256_HEX = /^[0-9a-f]{64}$/;

const assertSubmittable = (summary: Summary, rawDataHash: string): void => {
  if (summary.batchId === '') {
    throw new Error('submit requires a batchId');
  }
  if (!SHA256_HEX.test(rawDataHash)) {
    // The hash is the only link between the on-chain summary and the raw
    // series. Anchoring a malformed one produces evidence nobody can check.
    throw new Error(`submit requires a hex SHA-256 rawDataHash, got: ${rawDataHash}`);
  }
};

/**
 * Submit one summary over an already-open gateway connection. Separated from
 * `submit` so a caller pushing many windows reuses a single gRPC channel
 * instead of re-doing the TLS handshake per transaction.
 */
export const submitWith = async (
  connection: GatewayConnection,
  summary: Summary,
  rawDataHash: string,
): Promise<string> => {
  assertSubmittable(summary, rawDataHash);

  const contract = getNetwork(connection).getContract(
    connection.config.complianceChaincode,
    complianceContractName(),
  );

  // All chaincode arguments cross the wire as strings; the fixed 2-decimal
  // rendering keeps the value byte-identical for every endorsing peer.
  const proposal = contract.newProposal('SubmitTemperatureReading', {
    arguments: [
      summary.batchId,
      formatTempC(reportedTempC(summary, reportedStatFromEnv())),
      formatObservedAt(summary.observedAt),
      rawDataHash,
    ],
  });

  const transaction = await proposal.endorse();
  const commit = await transaction.submit();
  const status = await commit.getStatus();
  if (!status.successful) {
    throw new Error(
      `SubmitTemperatureReading for ${summary.batchId} failed to commit: status code ${String(status.code)}`,
    );
  }
  return commit.getTransactionId();
};

/**
 * Connect as the oracle, submit one summary, disconnect. Convenient for a
 * one-shot call; use `submitWith` inside a `withGateway` block for a batch.
 */
export const submit = async (summary: Summary, rawDataHash: string): Promise<void> => {
  // Validate before opening a connection: a bad argument should fail fast and
  // loudly rather than after a TLS handshake against a network that may be down.
  assertSubmittable(summary, rawDataHash);
  await withGateway(
    async (connection) => submitWith(connection, summary, rawDataHash),
    oracleConfig(),
  );
};

/** Submit a list of summaries over one connection, returning the transaction ids. */
export const submitAll = async (
  entries: ReadonlyArray<{ readonly summary: Summary; readonly rawDataHash: string }>,
): Promise<string[]> =>
  withGateway(async (connection) => {
    const ids: string[] = [];
    for (const entry of entries) {
      // Sequential on purpose: consecutive-breach counting in the chaincode
      // depends on submission order, and parallel submits would race in the
      // read-write sets and produce MVCC conflicts.
      ids.push(await submitWith(connection, entry.summary, entry.rawDataHash));
    }
    return ids;
  }, oracleConfig());
