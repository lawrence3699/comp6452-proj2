import { closeConnection, configFromEnv, connectAs, getContract } from './connect';

const REGISTRY_CHAINCODE = 'batch-registry';

// Must match TRANSIENT_KEY in chaincode/batch-registry/src/privateData.ts —
// frozen in docs/interfaces.md, so it is repeated here rather than imported
// across the chaincode/application package boundary.
const PRIVATE_DETAILS_KEY = 'batch_private_details';

interface RegisterArgs {
  readonly batchId: string;
  readonly foodType: string;
  readonly shelfLifeDays: number;
  readonly origin: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly inspectionNotes: string;
}

const usage =
  'usage: producer <batchId> <foodType> <shelfLifeDays> <origin> <quantity> ' +
  '[unitPrice] [inspectionNotes]';

const parseArgs = (argv: string[]): RegisterArgs => {
  const [batchId, foodType, shelfLifeDays, origin, quantity, unitPrice, inspectionNotes] = argv;
  if (!batchId || !foodType || !shelfLifeDays || !origin || !quantity) {
    throw new Error(usage);
  }
  return {
    batchId,
    foodType,
    shelfLifeDays: Number(shelfLifeDays),
    origin,
    quantity: Number(quantity),
    unitPrice: Number(unitPrice ?? 0),
    inspectionNotes: inspectionNotes ?? '',
  };
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const config = configFromEnv();
  const connection = await connectAs(config);

  try {
    const contract = getContract(connection, config, REGISTRY_CHAINCODE);

    const batchJson = JSON.stringify({
      batchId: args.batchId,
      foodType: args.foodType,
      producedAt: Math.floor(Date.now() / 1000),
      shelfLifeDays: args.shelfLifeDays,
      origin: args.origin,
      quantity: args.quantity,
    });

    // unitPrice and inspectionNotes travel in the transient map, never as a
    // normal argument, or they would land on the public ledger for every
    // organisation to read.
    await contract.submit('BatchRegistryContract:RegisterBatch', {
      arguments: [batchJson],
      transientData: {
        [PRIVATE_DETAILS_KEY]: JSON.stringify({
          batchId: args.batchId,
          unitPrice: args.unitPrice,
          inspectionNotes: args.inspectionNotes,
        }),
      },
    });

    console.log(`registered batch ${args.batchId}`);
  } finally {
    closeConnection(connection);
  }
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
