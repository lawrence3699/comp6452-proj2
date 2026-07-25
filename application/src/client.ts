/**
 * Gateway plumbing for the role clients — owner: person 4.
 *
 * The connection helper itself is NOT reimplemented here: it lives in
 * `@comp6452/offchain-shared` (person 3) and is already verified against the
 * live peer, so this module only adds what the clients need on top of it —
 * which identity a role signs as, and how a contract on a multi-contract
 * chaincode is addressed.
 */

import { Contract } from '@hyperledger/fabric-gateway';
import {
  FabricConfig,
  GatewayConnection,
  envOrDefault,
  getNetwork,
  loadConfig,
  withGateway,
} from '@comp6452/offchain-shared';

/**
 * Enrolment name each role signs as.
 *
 * This is the whole point of having three clients rather than one: every
 * command runs under the certificate of the role it belongs to, so an
 * access-control rejection in the demo is the network refusing a real
 * identity, not a flag we set ourselves. The names match
 * `network/registerIdentities.sh`.
 */
export const ROLE_IDENTITIES: Readonly<Record<string, string>> = {
  producer: 'producer1',
  transporter: 'transporter1',
  warehouse: 'warehouse1',
  regulator: 'regulator1',
  oracle: 'oracle1',
};

/**
 * Contract names inside each chaincode.
 *
 * Both chaincodes register more than one contract class, so a bare function
 * name is ambiguous and the peer rejects it. `getContract(chaincode, contract)`
 * is the gateway-side equivalent of the `Contract:Function` form used for
 * cross-chaincode invokes.
 */
export const REGISTRY_CONTRACT = 'BatchRegistryContract';
export const QUERY_CONTRACT = 'BatchQueryContract';
export const COMPLIANCE_CONTRACT = 'ComplianceContract';

/**
 * Config for a role.
 *
 * `--as` (surfaced as `identity`) beats the role default, which is what lets
 * the demo point a producer command at a transporter certificate to provoke
 * the access-control rejection. `FABRIC_USER` still wins over both, so a
 * marker running against their own network can override everything from the
 * environment without editing code.
 */
export const configFor = (role: string, identity?: string): FabricConfig => {
  const fallback = identity ?? ROLE_IDENTITIES[role];
  if (fallback === undefined) {
    throw new Error(
      `no identity known for role '${role}'; known roles: ${Object.keys(ROLE_IDENTITIES).join(', ')}`,
    );
  }
  return loadConfig({}, envOrDefault('FABRIC_USER', fallback));
};

/** The batch-registry write contract. */
export const registryContract = (connection: GatewayConnection): Contract =>
  getNetwork(connection).getContract(connection.config.registryChaincode, REGISTRY_CONTRACT);

/** The batch-registry read-only query contract. */
export const queryContract = (connection: GatewayConnection): Contract =>
  getNetwork(connection).getContract(connection.config.registryChaincode, QUERY_CONTRACT);

/** The coldchain-compliance contract. */
export const complianceContract = (connection: GatewayConnection): Contract =>
  getNetwork(connection).getContract(connection.config.complianceChaincode, COMPLIANCE_CONTRACT);

/** Run `work` as `role`, closing the gateway afterwards even if it throws. */
export const asRole = async <T>(
  role: string,
  identity: string | undefined,
  work: (connection: GatewayConnection) => Promise<T>,
): Promise<T> => withGateway(work, configFor(role, identity));

/** Decode a chaincode response and JSON-parse it. */
export const decodeJson = <T>(payload: Uint8Array): T =>
  JSON.parse(Buffer.from(payload).toString('utf8')) as T;

/** Decode a chaincode response as plain text. */
export const decodeText = (payload: Uint8Array): string =>
  Buffer.from(payload).toString('utf8');
