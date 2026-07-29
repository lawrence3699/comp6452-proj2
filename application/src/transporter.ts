import { closeConnection, configFromEnv, connectAs, getContract } from './connect';

const REGISTRY_CHAINCODE = 'batch-registry';

const usage = 'usage: transporter <batchId> <toMsp>';

const main = async (): Promise<void> => {
  const [batchId, toMsp] = process.argv.slice(2);
  if (!batchId || !toMsp) {
    throw new Error(usage);
  }

  const config = configFromEnv();
  const connection = await connectAs(config);

  try {
    const contract = getContract(connection, config, REGISTRY_CHAINCODE);
    await contract.submitTransaction('BatchRegistryContract:TransferCustody', batchId, toMsp);
    console.log(`transferred custody of ${batchId} to ${toMsp}`);
  } finally {
    closeConnection(connection);
  }
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
