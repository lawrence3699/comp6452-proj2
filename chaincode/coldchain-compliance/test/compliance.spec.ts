import { expect } from 'chai';
import { isBreach, rangeFor, DEFAULT_RANGE } from '../src/thresholds';

describe('temperature thresholds', () => {
  it('treats minus twenty as normal for frozen goods', () => {
    expect(isBreach('frozen', -20)).to.equal(false);
  });

  it('treats minus twenty as a breach for chilled goods', () => {
    expect(isBreach('chilled', -20)).to.equal(true);
  });

  it('falls back to the ambient range for an unknown food type', () => {
    expect(rangeFor('something-new')).to.deep.equal(DEFAULT_RANGE);
  });
});

// Required by the marking criteria. Owner: person 2.
describe('ComplianceContract', () => {
  it('does not flag a batch while readings stay inside the range');
  it('flags the batch through invokeChaincode once the breach count is reached');
  it('rejects a reading submitted by a non-oracle identity');
  it('cascades a recall to downstream batches');
});
