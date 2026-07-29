import { Context } from 'fabric-contract-api';

export const REGISTRY_CHAINCODE =
  'batch-registry';

export const REGISTRY_CHANNEL =
  'mychannel';

export const OK_STATUS = 200;

/**
 * Invoke the batch-registry chaincode.
 *
 * If the other chaincode returns an error, this function
 * converts it into a transaction error.
 *
 * Cross-chaincode writes remain atomic with the caller.
 */
export const invokeRegistry = async (
  ctx: Context,
  transaction: string,
  ...args: string[]
): Promise<Buffer> => {
  const response =
    await ctx.stub.invokeChaincode(
      REGISTRY_CHAINCODE,
      [
        transaction,
        ...args,
      ],
      REGISTRY_CHANNEL,
    );

  if (response.status !== OK_STATUS) {
    const detail =
      response.message ||
      (
        response.payload &&
        response.payload.length > 0
          ? Buffer.from(
              response.payload,
            ).toString('utf8')
          : 'unknown error'
      );

    throw new Error(
      `batch-registry ${transaction} failed: ${detail}`,
    );
  }

  return Buffer.from(
    response.payload ??
      Buffer.alloc(0),
  );
};
