/**
 * Shared off-chain plumbing — owner: person 3.
 *
 * Consumed by `oracle-service` and `indexer` through a `file:` dependency, so
 * both services connect to the network the same way and there is one place to
 * change when the peer moves.
 */

export {
  DEFAULT_USER,
  FabricConfig,
  cryptoPath,
  envOrDefault,
  loadConfig,
  orgDomain,
  testNetworkPath,
  userMspPath,
} from './config';

export {
  GatewayConnection,
  connectGateway,
  getContract,
  getNetwork,
  newGrpcConnection,
  newIdentity,
  newSigner,
  withGateway,
} from './gateway';
