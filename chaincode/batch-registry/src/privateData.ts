import { Context } from 'fabric-contract-api';

export const COLLECTION = 'batchPrivateDetails';

/** Transient-map key the client must use when supplying private details. */
export const TRANSIENT_KEY = 'batch_private_details';

export interface BatchPrivateDetails {
  readonly batchId: string;
  readonly unitPrice: number;
  readonly inspectionNotes: string;
}

/**
 * Write commercially sensitive fields into the private data collection.
 *
 * Only a hash of this payload reaches the public ledger; the values themselves
 * are gossiped solely to organisations in the collection policy. This is what
 * justifies choosing Fabric over a public chain — on a public ledger every
 * competitor could read the unit price.
 */
export const putPrivateDetails = async (
  ctx: Context,
  details: BatchPrivateDetails,
): Promise<void> => {
  if (!details.batchId) {
    throw new Error('private details: batchId is required');
  }
  if (!Number.isFinite(details.unitPrice) || details.unitPrice < 0) {
    throw new Error('private details: unitPrice must be a non-negative number');
  }

  await ctx.stub.putPrivateData(
    COLLECTION,
    details.batchId,
    Buffer.from(JSON.stringify(details)),
  );
};

/**
 * Read private details back.
 *
 * A peer whose organisation is not in the collection policy simply holds no
 * data, so an empty read is reported as one combined failure rather than
 * distinguishing "missing" from "forbidden" — telling the two apart would leak
 * the existence of batches the caller may not know about.
 */
export const getPrivateDetails = async (
  ctx: Context,
  batchId: string,
): Promise<BatchPrivateDetails> => {
  const raw = await ctx.stub.getPrivateData(COLLECTION, batchId);

  if (!raw || raw.length === 0) {
    throw new Error(
      `no private details readable for batch ${batchId}: the batch may not exist, ` +
        `or your organisation may not be a member of collection ${COLLECTION}`,
    );
  }

  return JSON.parse(raw.toString()) as BatchPrivateDetails;
};

/**
 * Read the private-data hash from the public ledger.
 *
 * Every peer can read this even without collection membership, which is how an
 * auditor proves the private payload has not been altered since commit.
 */
export const getPrivateDetailsHash = async (
  ctx: Context,
  batchId: string,
): Promise<string> => {
  const hash = await ctx.stub.getPrivateDataHash(COLLECTION, batchId);

  if (!hash || hash.length === 0) {
    throw new Error(`no private data hash on the ledger for batch ${batchId}`);
  }

  return Buffer.from(hash).toString('hex');
};

/**
 * Extract private details from the transient map, or null when absent.
 *
 * Sensitive values must arrive this way, never as a normal argument: normal
 * args are recorded in the transaction proposal and end up on the public
 * ledger for every org to read, defeating the point of the collection.
 */
export const readTransientDetails = (
  ctx: Context,
  batchId: string,
): BatchPrivateDetails | null => {
  const transient = ctx.stub.getTransient();
  const raw = transient.get(TRANSIENT_KEY);

  if (!raw || raw.length === 0) {
    return null;
  }

  const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as Partial<BatchPrivateDetails>;

  return {
    batchId,
    unitPrice: Number(parsed.unitPrice),
    inspectionNotes: String(parsed.inspectionNotes ?? ''),
  };
};
