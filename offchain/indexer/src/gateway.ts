/**
 * Fabric gateway event adapter for the indexer — owner: person 3.
 *
 * Reads the same RoleConfig environment shape person 4 emits per identity, so
 * it runs off any member's env file, e.g.:
 *
 *   export $(cat network/identities/regulator1.env | xargs)
 *
 * This client only reads events, so any enrolled member identity works — it
 * does not need the oracle attribute. Kept out of the pure logic in ./index
 * (imported lazily) so the unit tests never load fabric-gateway. UNVERIFIED
 * until the network is up.
 */

import { createPrivateKey } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import * as grpc from '@grpc/grpc-js';
import { connect, hash, signers, Identity, Signer } from '@hyperledger/fabric-gateway';
import type { EventSource, RawChaincodeEvent } from './index';

/** Chaincodes whose events this indexer subscribes to. */
const INDEXED_CHAINCODES = ['batch-registry', 'coldchain-compliance'] as const;

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
};

const firstFileIn = async (directory: string): Promise<Buffer> => {
  const files = await fs.readdir(directory);
  if (files.length === 0) {
    throw new Error(`no file found in ${directory}`);
  }
  return fs.readFile(join(directory, files[0]));
};

export interface EventSources {
  readonly sources: EventSource[];
  readonly close: () => void;
}

export const connectEventSources = async (): Promise<EventSources> => {
  const mspId = env('MSP_ID');
  const peerEndpoint = env('PEER_ENDPOINT');
  const peerHostAlias = env('PEER_HOST_ALIAS');
  const channelName = process.env.CHANNEL_NAME ?? 'mychannel';

  const tlsRootCert = await fs.readFile(env('TLS_CERT_PATH'));
  const certificate = await firstFileIn(env('CERT_DIRECTORY_PATH'));
  const privateKeyPem = await firstFileIn(env('KEY_DIRECTORY_PATH'));

  const client = new grpc.Client(peerEndpoint, grpc.credentials.createSsl(tlsRootCert), {
    'grpc.ssl_target_name_override': peerHostAlias,
  });

  const identity: Identity = { mspId, credentials: certificate };
  const signer: Signer = signers.newPrivateKeySigner(createPrivateKey(privateKeyPem));

  const gateway = connect({ client, identity, signer, hash: hash.sha256 });

  const network = gateway.getNetwork(channelName);
  // startBlock 0 replays the batch's full history on start, so a fresh indexer
  // rebuilds the whole traceability trail. A production indexer would persist a
  // checkpoint and resume from it instead.
  const streams = await Promise.all(
    INDEXED_CHAINCODES.map((name) => network.getChaincodeEvents(name, { startBlock: BigInt(0) })),
  );

  const sources: EventSource[] = streams.map((stream) => ({
    async *events(): AsyncIterable<RawChaincodeEvent> {
      for await (const event of stream) {
        yield {
          eventName: event.eventName,
          payload: event.payload,
          blockNumber: Number(event.blockNumber),
          transactionId: event.transactionId,
        };
      }
    },
  }));

  return {
    sources,
    close: () => {
      streams.forEach((stream) => stream.close());
      gateway.close();
      client.close();
    },
  };
};
