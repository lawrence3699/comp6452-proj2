import { Context, Contract } from 'fabric-contract-api';

/**
 * FR1 batch registration and the custody write path.
 * Owner: person 1. The read-only query path lives in queries.ts (person 4).
 */
export class BatchRegistryContract extends Contract {
  // TODO(person 1): producers only. Validate shelfLifeDays > 0 and that
  // producedAt is not in the future, then emit BatchRegistered.
  public async RegisterBatch(_ctx: Context, _batchJson: string): Promise<void> {
    throw new Error('not implemented');
  }

  // TODO(person 1): the caller must be the current holder, and the status
  // change must satisfy assertTransition. Emit CustodyTransferred.
  public async TransferCustody(_ctx: Context, _batchId: string, _toMsp: string): Promise<void> {
    throw new Error('not implemented');
  }

  // TODO(person 1): callable by a regulator directly (FR3) and by
  // coldchain-compliance through invokeChaincode. Emit BatchFlagged.
  public async FlagBatch(
    _ctx: Context,
    _batchId: string,
    _reason: string,
    _evidenceHash: string,
  ): Promise<void> {
    throw new Error('not implemented');
  }
}
