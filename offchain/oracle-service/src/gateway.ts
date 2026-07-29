/**
 * Fabric gateway adapter for the oracle — owner: person 3.
 *
 * Reads the same RoleConfig environment shape person 4's network emits per
 * identity (network/identities/<name>.env), so the oracle runs straight off
 * oracle1.env:
 *
 *   export $(cat network/identities/oracle1.env | xargs)
 *
 * That identity MUST carry oracle=true (coldchain-compliance's assertOracle
 * checks it); person 4's setupDemoIdentities.sh issues oracle1 in Org2 with
 * that attribute.
 *
 * Kept out of the pure logic in ./index (imported lazily) so the unit tests
 * never load fabric-gateway. UNVERIFIED until the network is up.
 */

import { createPrivateKey } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import * as grpc from '@grpc/grpc-js';
import { connect, hash, signers, Identity, Signer } from '@hyperledger/fabric-gateway';
import type { ChaincodeSubmitter } from './index';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
};

/** The MSP layout keeps the cert/key under a generated filename in a directory. */
const firstFileIn = async (directory: string): Promise<Buffer> => {
  const files = await fs.readdir(directory);
  if (files.length === 0) {
    throw new Error(`no file found in ${directory}`);
  }
  return fs.readFile(join(directory, files[0]));
};

export interface OracleConnection {
  readonly submitter: ChaincodeSubmitter;
  readonly close: () => void;
}

export const connectOracleSubmitter = async (): Promise<OracleConnection> => {
  const mspId = env('MSP_ID');
  const peerEndpoint = env('PEER_ENDPOINT');
  const peerHostAlias = env('PEER_HOST_ALIAS');
  const channelName = process.env.CHANNEL_NAME ?? 'mychannel';
  const chaincodeName = process.env.COMPLIANCE_CHAINCODE ?? 'coldchain-compliance';

  const tlsRootCert = await fs.readFile(env('TLS_CERT_PATH'));
  const certificate = await firstFileIn(env('CERT_DIRECTORY_PATH'));
  const privateKeyPem = await firstFileIn(env('KEY_DIRECTORY_PATH'));

  const client = new grpc.Client(peerEndpoint, grpc.credentials.createSsl(tlsRootCert), {
    'grpc.ssl_target_name_override': peerHostAlias,
  });

  const identity: Identity = { mspId, credentials: certificate };
  const signer: Signer = signers.newPrivateKeySigner(createPrivateKey(privateKeyPem));

  const gateway = connect({
    client,
    identity,
    signer,
    hash: hash.sha256,
    evaluateOptions: () => ({ deadline: Date.now() + 5_000 }),
    endorseOptions: () => ({ deadline: Date.now() + 15_000 }),
    submitOptions: () => ({ deadline: Date.now() + 5_000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60_000 }),
  });

  const contract = gateway.getNetwork(channelName).getContract(chaincodeName);
  const submitter: ChaincodeSubmitter = {
    submitTransaction: (name, ...args) => contract.submitTransaction(name, ...args),
  };

  return {
    submitter,
    close: () => {
      gateway.close();
      client.close();
    },
  };
};
