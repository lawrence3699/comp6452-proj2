import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { connect, Contract, Gateway, Identity, Signer, signers } from '@hyperledger/fabric-gateway';

/**
 * Same shape as application/src/connect.ts's RoleConfig. Duplicated rather
 * than imported: this suite drives four identities (producer, transporter,
 * oracle, regulator) at once, each loaded from its own file below, whereas
 * the application clients are single-identity processes that read straight
 * from process.env — different enough loading strategies that sharing one
 * module would mean threading an unused env-vs-file switch through it.
 */
export interface RoleConfig {
  readonly mspId: string;
  readonly certDirectoryPath: string;
  readonly keyDirectoryPath: string;
  readonly tlsCertPath: string;
  readonly peerEndpoint: string;
  readonly peerHostAlias: string;
  readonly channelName: string;
}

/**
 * Parses the flat KEY=VALUE files network/scripts/registerIdentity.sh
 * writes under network/identities/<name>.env.
 */
export const configFromFile = async (envFilePath: string): Promise<RoleConfig> => {
  const content = await fs.readFile(envFilePath, 'utf8');
  const values: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    values[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }

  const require = (name: string): string => {
    const value = values[name];
    if (!value) {
      throw new Error(`${envFilePath}: missing ${name}`);
    }
    return value;
  };

  return {
    mspId: require('MSP_ID'),
    certDirectoryPath: require('CERT_DIRECTORY_PATH'),
    keyDirectoryPath: require('KEY_DIRECTORY_PATH'),
    tlsCertPath: require('TLS_CERT_PATH'),
    peerEndpoint: require('PEER_ENDPOINT'),
    peerHostAlias: require('PEER_HOST_ALIAS'),
    channelName: values.CHANNEL_NAME ?? 'mychannel',
  };
};

const firstFileIn = async (directoryPath: string): Promise<string> => {
  const files = await fs.readdir(directoryPath);
  if (files.length === 0) {
    throw new Error(`no files found in ${directoryPath}`);
  }
  return path.join(directoryPath, files[0]);
};

const newIdentity = async (config: RoleConfig): Promise<Identity> => {
  const certPath = await firstFileIn(config.certDirectoryPath);
  const credentials = await fs.readFile(certPath);
  return { mspId: config.mspId, credentials };
};

const newSigner = async (config: RoleConfig): Promise<Signer> => {
  const keyPath = await firstFileIn(config.keyDirectoryPath);
  const privateKeyPem = await fs.readFile(keyPath);
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  return signers.newPrivateKeySigner(privateKey);
};

const newGrpcConnection = async (config: RoleConfig): Promise<grpc.Client> => {
  const tlsRootCert = await fs.readFile(config.tlsCertPath);
  const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
  return new grpc.Client(config.peerEndpoint, tlsCredentials, {
    'grpc.ssl_target_name_override': config.peerHostAlias,
  });
};

export interface Connection {
  readonly gateway: Gateway;
  readonly grpcClient: grpc.Client;
}

export const connectAs = async (config: RoleConfig): Promise<Connection> => {
  const grpcClient = await newGrpcConnection(config);
  const gateway = connect({
    client: grpcClient,
    identity: await newIdentity(config),
    signer: await newSigner(config),
    evaluateOptions: () => ({ deadline: Date.now() + 5_000 }),
    endorseOptions: () => ({ deadline: Date.now() + 15_000 }),
    submitOptions: () => ({ deadline: Date.now() + 5_000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60_000 }),
  });
  return { gateway, grpcClient };
};

export const closeConnection = (connection: Connection): void => {
  connection.gateway.close();
  connection.grpcClient.close();
};

export const getContract = (
  connection: Connection,
  config: RoleConfig,
  chaincodeName: string,
): Contract => connection.gateway.getNetwork(config.channelName).getContract(chaincodeName);
