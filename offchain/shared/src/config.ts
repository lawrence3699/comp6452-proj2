/**
 * Environment-driven configuration for every off-chain service — owner: person 3.
 *
 * The oracle service and the event indexer both dial the same peer with the
 * same crypto material, so the resolution rules live here once. Nothing is
 * hard-coded: every field has a sensible test-network default and an env
 * override, which is what lets the same build run against a marker's network.
 */

import * as os from 'os';
import * as path from 'path';

export interface FabricConfig {
  /** Channel the two chaincodes are committed to. */
  readonly channelName: string;
  /** MSP that signs our transactions. */
  readonly mspId: string;
  /** host:port of the gateway peer. */
  readonly peerEndpoint: string;
  /** Certificate SAN of the peer — the test network's certs name the container, not localhost. */
  readonly peerHostAlias: string;
  /** Peer TLS root certificate used to authenticate the gRPC channel. */
  readonly tlsCertPath: string;
  /** Directory holding the signing certificate of the identity we act as. */
  readonly certDirectoryPath: string;
  /** Directory holding that identity's private key. */
  readonly keyDirectoryPath: string;
  /** Chaincode the oracle submits temperature summaries to. */
  readonly complianceChaincode: string;
  /** Chaincode holding the batch state, queried by the indexer. */
  readonly registryChaincode: string;
}

/**
 * Treat an empty string the same as unset. Shell scripts routinely export
 * `FOO=` when a value is missing, and silently building a path from "" is far
 * harder to debug than falling back to the default.
 */
export const envOrDefault = (key: string, fallback: string): string => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
};

/** Root of the fabric-samples test network (where `network/` provisions crypto material). */
export const testNetworkPath = (): string =>
  envOrDefault(
    'FABRIC_TEST_NETWORK',
    path.join(os.homedir(), 'fabric-bootstrap', 'fabric-samples', 'test-network'),
  );

/** Org domain, e.g. `org1.example.com`. Drives both the crypto path and the user directory name. */
export const orgDomain = (): string => envOrDefault('ORG_DOMAIN', 'org1.example.com');

/** `organizations/peerOrganizations/<org domain>` — the parent of msp/, tls/ and users/. */
export const cryptoPath = (): string =>
  envOrDefault(
    'CRYPTO_PATH',
    path.join(testNetworkPath(), 'organizations', 'peerOrganizations', orgDomain()),
  );

/**
 * MSP directory of the identity we sign as. `FABRIC_USER` accepts either the
 * bare enrolment name registered with the CA (`oracle1`) or the fully
 * qualified directory name (`User1@org1.example.com`); Fabric CA writes the
 * former, cryptogen the latter, and the demo uses both.
 */
export const DEFAULT_USER = 'User1';

export const userMspPath = (
  user: string = envOrDefault('FABRIC_USER', DEFAULT_USER),
): string => {
  const directory = user.includes('@') ? user : `${user}@${orgDomain()}`;
  return path.join(cryptoPath(), 'users', directory, 'msp');
};

/**
 * Read the configuration out of the environment. Resolved on every call rather
 * than memoised at import time so a caller (or a unit test) can change the
 * environment and get the change, and so `submit()` and `listen()` cannot
 * disagree about which peer they are talking to.
 *
 * `defaultUser` lets a service choose the identity it acts as by default (the
 * oracle signs as `oracle1`) while `FABRIC_USER` still overrides it. It is a
 * parameter rather than the service assigning to `process.env`, because that
 * assignment would leak into every later call in the process.
 */
export const loadConfig = (
  overrides: Partial<FabricConfig> = {},
  defaultUser: string = DEFAULT_USER,
): FabricConfig => {
  const mspDir = userMspPath(envOrDefault('FABRIC_USER', defaultUser));
  return {
    channelName: envOrDefault('CHANNEL_NAME', 'mychannel'),
    mspId: envOrDefault('MSP_ID', 'Org1MSP'),
    peerEndpoint: envOrDefault('PEER_ENDPOINT', 'localhost:7051'),
    peerHostAlias: envOrDefault('PEER_HOST_ALIAS', 'peer0.org1.example.com'),
    tlsCertPath: envOrDefault(
      'TLS_CERT_PATH',
      path.join(cryptoPath(), 'peers', `peer0.${orgDomain()}`, 'tls', 'ca.crt'),
    ),
    certDirectoryPath: envOrDefault('CERT_DIRECTORY_PATH', path.join(mspDir, 'signcerts')),
    keyDirectoryPath: envOrDefault('KEY_DIRECTORY_PATH', path.join(mspDir, 'keystore')),
    complianceChaincode: envOrDefault('COMPLIANCE_CHAINCODE', 'coldchain-compliance'),
    registryChaincode: envOrDefault('REGISTRY_CHAINCODE', 'batch-registry'),
    ...overrides,
  };
};
