/**
 * Fabric Gateway connection helper — owner: person 3.
 *
 * Shared by the oracle service (submits) and the indexer (listens), so the
 * gRPC/TLS/identity plumbing exists exactly once. Fabric 2.5's gateway peer
 * does the endorsement fan-out for us, so a single peer connection is enough.
 */

import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as grpc from '@grpc/grpc-js';
import {
  connect,
  hash,
  signers,
  Contract,
  Gateway,
  Identity,
  Network,
  Signer,
} from '@hyperledger/fabric-gateway';
import { FabricConfig, loadConfig } from './config';

export interface GatewayConnection {
  readonly gateway: Gateway;
  readonly config: FabricConfig;
  /** Closes the gateway and the underlying gRPC channel. Always call it, or node will not exit. */
  readonly close: () => void;
}

/**
 * First regular file in a directory. Fabric writes the signing certificate and
 * the private key under randomly named files, so there is nothing to match on
 * — but a missing directory is the single most common setup mistake, so the
 * error names the path and lists what identities do exist.
 */
const firstFileIn = async (directory: string): Promise<string> => {
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    const usersDir = path.resolve(directory, '..', '..', '..');
    const available = await fs.readdir(usersDir).catch(() => [] as string[]);
    throw new Error(
      `identity material not found at ${directory}; identities present in ${usersDir}: ` +
        `${available.length > 0 ? available.join(', ') : '(none)'}. ` +
        'Set FABRIC_USER / CRYPTO_PATH, or run the network enrolment script first.',
    );
  }
  const file = entries.find((entry) => !entry.startsWith('.'));
  if (file === undefined) {
    throw new Error(`identity material directory is empty: ${directory}`);
  }
  return path.join(directory, file);
};

export const newGrpcConnection = async (config: FabricConfig): Promise<grpc.Client> => {
  const tlsRootCert = await fs.readFile(config.tlsCertPath).catch(() => {
    throw new Error(
      `peer TLS root certificate not found at ${config.tlsCertPath}; set TLS_CERT_PATH or FABRIC_TEST_NETWORK`,
    );
  });
  const credentials = grpc.credentials.createSsl(tlsRootCert);
  // The peer's certificate is issued to peer0.org1.example.com, but we dial
  // localhost, so the SNI/hostname check has to be pointed at the real SAN.
  return new grpc.Client(config.peerEndpoint, credentials, {
    'grpc.ssl_target_name_override': config.peerHostAlias,
  });
};

export const newIdentity = async (config: FabricConfig): Promise<Identity> => {
  const credentials = await fs.readFile(await firstFileIn(config.certDirectoryPath));
  return { mspId: config.mspId, credentials };
};

export const newSigner = async (config: FabricConfig): Promise<Signer> => {
  const privateKeyPem = await fs.readFile(await firstFileIn(config.keyDirectoryPath));
  return signers.newPrivateKeySigner(crypto.createPrivateKey(privateKeyPem));
};

/**
 * Open a gateway connection. Deadlines are generous on endorsement and commit
 * because the CCaaS chaincode containers are cold on the first invoke of a run.
 */
export const connectGateway = async (
  config: FabricConfig = loadConfig(),
): Promise<GatewayConnection> => {
  const client = await newGrpcConnection(config);
  const gateway = connect({
    client,
    identity: await newIdentity(config),
    signer: await newSigner(config),
    hash: hash.sha256,
    evaluateOptions: () => ({ deadline: Date.now() + 10_000 }),
    endorseOptions: () => ({ deadline: Date.now() + 30_000 }),
    submitOptions: () => ({ deadline: Date.now() + 10_000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60_000 }),
  });
  return {
    gateway,
    config,
    close: () => {
      gateway.close();
      client.close();
    },
  };
};

export const getNetwork = (connection: GatewayConnection): Network =>
  connection.gateway.getNetwork(connection.config.channelName);

export const getContract = (connection: GatewayConnection, chaincodeName: string): Contract =>
  getNetwork(connection).getContract(chaincodeName);

/**
 * Run `work` against a freshly opened gateway and close it afterwards, even if
 * `work` throws. Leaking a gRPC channel leaves the process hanging, which in a
 * demo looks exactly like a stuck transaction.
 */
export const withGateway = async <T>(
  work: (connection: GatewayConnection) => Promise<T>,
  config: FabricConfig = loadConfig(),
): Promise<T> => {
  const connection = await connectGateway(config);
  try {
    return await work(connection);
  } finally {
    connection.close();
  }
};
