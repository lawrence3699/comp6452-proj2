/**
 * Role clients — owner: person 4.
 *
 * Four CLI clients on `@hyperledger/fabric-gateway`, each signing with its own
 * Fabric CA identity so the demo shows access control being enforced rather
 * than one super-user doing everything. The gateway connection helper itself is
 * reused from `@comp6452/offchain-shared` through a `file:` dependency — there
 * is exactly one place in this repository that dials a peer.
 */

export {
  BOOLEAN_FLAGS,
  ParsedCommand,
  hasFlag,
  numberOption,
  option,
  parseArgs,
  requireOption,
} from './args';

export {
  COMPLIANCE_CONTRACT,
  QUERY_CONTRACT,
  REGISTRY_CONTRACT,
  ROLE_IDENTITIES,
  asRole,
  complianceContract,
  configFor,
  decodeJson,
  decodeText,
  queryContract,
  registryContract,
} from './client';

export {
  Explanation,
  GatewayErrorLike,
  chaincodeMessage,
  describeFailure,
  explain,
  isPolicyRejection,
  rawMessage,
} from './errors';

export {
  Batch,
  HistoryEntry,
  StoredReading,
  formatBatch,
  formatBatchLine,
  formatHistory,
  formatHolderInventory,
  formatReadings,
  formatUnixSeconds,
  generateBatchId,
  section,
  shortHash,
  step,
} from './format';

export {
  InspectionReport,
  PrivateDetails,
  RegisterInput,
  TRANSIENT_KEY,
  buildPrivateDetails,
  buildRegisterInput,
  registerBatch,
  runProducer,
  storeInspectionReport,
} from './producer';

export { TransitEvent, logTransitEvent, runTransporter, transferCustody } from './transporter';

export { markDelivered, runWarehouse } from './warehouse';

export { flagBatch, recallBatch, runRegulator } from './regulator';

export { HANDLERS, RunResult, contextFor, handlerFor, run, wantsHelp } from './run';

export { USAGE } from './usage';
