import * as crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { connect, Contract, Gateway, Identity, Signer, signers } from '@hyperledger/fabric-gateway';

/**
 * Everything needed to connect to the gateway as one identity.
 *
 * Each role (producer, transporter, regulator) points these at its own
 * enrolment certificate rather than a shared admin identity, so the demo
 * shows access control taking effect instead of one super user doing
 * everything — see application/README.md.
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

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
};

/**
 * Reads connection details from the environment rather than a config file,
 * so the same compiled script serves all three roles: which identity it
 * runs as is decided by which env vars are set when the process starts, not
 * by a command-line flag baked into this code.
 */
export const configFromEnv = (): RoleConfig => ({
  mspId: requireEnv('MSP_ID'),
  certDirectoryPath: requireEnv('CERT_DIRECTORY_PATH'),
  keyDirectoryPath: requireEnv('KEY_DIRECTORY_PATH'),
  tlsCertPath: requireEnv('TLS_CERT_PATH'),
  peerEndpoint: requireEnv('PEER_ENDPOINT'),
  peerHostAlias: requireEnv('PEER_HOST_ALIAS'),
  channelName: process.env.CHANNEL_NAME ?? 'mychannel',
});

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

/**
 * Both chaincodes register more than one contract (e.g. batch-registry has
 * BatchRegistryContract and BatchQueryContract), so transaction names are
 * always qualified as `ContractName:Function` here — relying on whichever
 * contract Fabric treats as the unqualified default is not worth the
 * ambiguity.
 */
export const getContract = (
  connection: Connection,
  config: RoleConfig,
  chaincodeName: string,
): Contract => connection.gateway.getNetwork(config.channelName).getContract(chaincodeName);
