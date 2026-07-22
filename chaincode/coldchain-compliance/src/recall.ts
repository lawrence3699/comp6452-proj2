import { Context } from 'fabric-contract-api';

// TODO(person 2): walk the downstream batches derived from this one and
// recall each of them, so a single contaminated batch cascades correctly.
export const cascadeRecall = async (_ctx: Context, _batchId: string): Promise<string[]> => {
  throw new Error('not implemented');
};
