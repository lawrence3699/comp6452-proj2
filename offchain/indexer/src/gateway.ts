/**
 * Fabric gateway event adapter for the indexer — owner: person 3.
 *
 * UNVERIFIED: needs the test network running and person 4's connection details
 * before it can be validated. Configured from environment variables and kept
 * out of the pure logic in ./index (imported lazily) so the unit tests never
 * load fabric-gateway. This client only reads events, so it can use any valid
 * member identity — it does not need the oracle attribute.
 */

import { createPrivateKey } from 'crypto';
import { readFileSync } from 'fs';
import * as grpc from '@grpc/grpc-js';
import { connect, hash, signers } from '@hyperledger/fabric-gateway';
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

export interface EventSources {
  readonly sources: EventSource[];
  readonly close: () => void;
}

export const connectEventSources = async (): Promise<EventSources> => {
  const peerEndpoint = env('INDEXER_PEER_ENDPOINT');
  const peerHostAlias = env('INDEXER_PEER_HOST_ALIAS');
  const mspId = env('INDEXER_MSP_ID');
  const tlsRootCert = readFileSync(env('INDEXER_TLS_ROOT_CERT'));
  const certificate = readFileSync(env('INDEXER_CERT'));
  const privateKeyPem = readFileSync(env('INDEXER_KEY'));
  const channelName = process.env.CHANNEL_NAME ?? 'mychannel';

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

  const network = gateway.getNetwork(channelName);
  const streams = await Promise.all(
    INDEXED_CHAINCODES.map((name) => network.getChaincodeEvents(name)),
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
