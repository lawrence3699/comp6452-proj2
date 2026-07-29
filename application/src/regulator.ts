import { closeConnection, configFromEnv, connectAs, getContract } from './connect';

const REGISTRY_CHAINCODE = 'batch-registry';
const COMPLIANCE_CHAINCODE = 'coldchain-compliance';

const usage =
  'usage: regulator flag <batchId> <reason> <evidenceHash>\n' +
  '       regulator history <batchId>';

const flag = async (
  connection: Awaited<ReturnType<typeof connectAs>>,
  config: ReturnType<typeof configFromEnv>,
  args: string[],
): Promise<void> => {
  const [batchId, reason, evidenceHash] = args;
  if (!batchId || !reason || !evidenceHash) {
    throw new Error(usage);
  }

  // Routed through coldchain-compliance's own business logic rather than
  // calling batch-registry's FlagBatch directly, so a manual regulator flag
  // leaves the same audit trail as the automated oracle path (see
  // docs/interfaces.md).
  const contract = getContract(connection, config, COMPLIANCE_CHAINCODE);
  await contract.submitTransaction('ComplianceContract:FlagByRegulator', batchId, reason, evidenceHash);
  console.log(`flagged batch ${batchId}`);
};

const history = async (
  connection: Awaited<ReturnType<typeof connectAs>>,
  config: ReturnType<typeof configFromEnv>,
  args: string[],
): Promise<void> => {
  const [batchId] = args;
  if (!batchId) {
    throw new Error(usage);
  }

  const contract = getContract(connection, config, REGISTRY_CHAINCODE);
  const result = await contract.evaluateTransaction('BatchQueryContract:GetBatchHistory', batchId);
  console.log(Buffer.from(result).toString());
};

const main = async (): Promise<void> => {
  const [command, ...rest] = process.argv.slice(2);
  const config = configFromEnv();
  const connection = await connectAs(config);

  try {
    if (command === 'flag') {
      await flag(connection, config, rest);
    } else if (command === 'history') {
      await history(connection, config, rest);
    } else {
      throw new Error(usage);
    }
  } finally {
    closeConnection(connection);
  }
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
