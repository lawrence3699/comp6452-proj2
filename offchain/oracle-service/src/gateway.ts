/**
 * Fabric gateway adapter for the oracle — owner: person 3.
 *
 * UNVERIFIED: this needs the test network running and person 4's connection
 * details before it can be validated. It is configured entirely from
 * environment variables so nothing is hard-coded, and it is kept out of the
 * pure logic in ./index (imported lazily) so the unit tests never load
 * fabric-gateway.
 *
 * The oracle identity (ORACLE_CERT / ORACLE_KEY) MUST carry the 'oracle'
 * attribute that coldchain-compliance's assertOracle checks, otherwise every
 * submit is rejected — coordinate the certificate issuance with persons 2 & 4.
 */

import { createPrivateKey } from 'crypto';
import { readFileSync } from 'fs';
import * as grpc from '@grpc/grpc-js';
import { connect, hash, signers } from '@hyperledger/fabric-gateway';
import type { ChaincodeSubmitter } from './index';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
};

export interface OracleConnection {
  readonly submitter: ChaincodeSubmitter;
  readonly close: () => void;
}

export const connectOracleSubmitter = async (): Promise<OracleConnection> => {
  const peerEndpoint = env('ORACLE_PEER_ENDPOINT'); // e.g. localhost:7051
  const peerHostAlias = env('ORACLE_PEER_HOST_ALIAS'); // e.g. peer0.org1.example.com
  const mspId = env('ORACLE_MSP_ID'); // e.g. Org1MSP
  const tlsRootCert = readFileSync(env('ORACLE_TLS_ROOT_CERT'));
  const certificate = readFileSync(env('ORACLE_CERT'));
  const privateKeyPem = readFileSync(env('ORACLE_KEY'));
  const channelName = process.env.CHANNEL_NAME ?? 'mychannel';
  const chaincodeName = process.env.COMPLIANCE_CHAINCODE ?? 'coldchain-compliance';

  const client = new grpc.Client(
    peerEndpoint,
    grpc.credentials.createSsl(tlsRootCert),
    { 'grpc.ssl_target_name_override': peerHostAlias },
  );

  const gateway = connect({
    client,
    identity: { mspId, credentials: certificate },
    signer: signers.newPrivateKeySigner(createPrivateKey(privateKeyPem)),
    hash: hash.sha256,
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
