import { Context, Contract } from 'fabric-contract-api';

/**
 * FR2 traceability queries. Read-only, kept in its own file so that person 4
 * and person 1 never edit the same file.
 * Owner: person 4.
 */
export class BatchQueryContract extends Contract {
  // TODO(person 4): return the full custody history using
  // ctx.stub.getHistoryForKey.
  public async GetBatchHistory(_ctx: Context, _batchId: string): Promise<string> {
    throw new Error('not implemented');
  }

  // TODO(person 4): range query over a composite key built with
  // ctx.stub.createCompositeKey('holder~batchId', [...]).
  public async GetBatchesByHolder(_ctx: Context, _holderMsp: string): Promise<string> {
    throw new Error('not implemented');
  }
}
