import { Context } from 'fabric-contract-api';

export const COLLECTION = 'batchPrivateDetails';

export interface BatchPrivateDetails {
  readonly batchId: string;
  readonly unitPrice: number;
  readonly inspectionNotes: string;
}

// TODO(person 1): write the commercially sensitive fields into the private
// data collection with ctx.stub.putPrivateData, keeping only a hash on the
// public ledger. This is what justifies choosing Fabric over a public chain.
export const putPrivateDetails = async (
  _ctx: Context,
  _details: BatchPrivateDetails,
): Promise<void> => {
  throw new Error('not implemented');
};

// TODO(person 1): read back with ctx.stub.getPrivateData and fail clearly when
// the caller's organisation is not a member of the collection.
export const getPrivateDetails = async (
  _ctx: Context,
  _batchId: string,
): Promise<BatchPrivateDetails> => {
  throw new Error('not implemented');
};
