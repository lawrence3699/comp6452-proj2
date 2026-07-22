import { Context, Contract } from 'fabric-contract-api';

export const REGISTRY_CHAINCODE = 'batch-registry';

/**
 * FR3 problem batch marking, driven by oracle temperature readings.
 * Owner: person 2.
 */
export class ComplianceContract extends Contract {
  // TODO(person 2): assertOracle, persist the reading, count consecutive
  // breaches with isBreach, and once VIOLATIONS_BEFORE_FLAG is reached call
  // ctx.stub.invokeChaincode(REGISTRY_CHAINCODE, ['FlagBatch', ...], 'mychannel').
  public async SubmitTemperatureReading(
    _ctx: Context,
    _batchId: string,
    _tempC: string,
    _observedAt: string,
    _rawDataHash: string,
  ): Promise<void> {
    throw new Error('not implemented');
  }

  // TODO(person 2): regulators may flag a batch by hand, independent of the
  // oracle path.
  public async FlagByRegulator(
    _ctx: Context,
    _batchId: string,
    _reason: string,
    _evidenceHash: string,
  ): Promise<void> {
    throw new Error('not implemented');
  }

  // TODO(person 2): recall the batch and everything derived from it.
  public async RecallBatch(_ctx: Context, _batchId: string): Promise<void> {
    throw new Error('not implemented');
  }
}
