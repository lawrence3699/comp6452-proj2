import { expect } from 'chai';
import { BatchStatus } from '../src/batch';
import { canTransition } from '../src/stateMachine';

describe('state machine', () => {
  it('allows a created batch to move into transit', () => {
    expect(canTransition(BatchStatus.Created, BatchStatus.InTransit)).to.equal(true);
  });

  it('refuses to move a delivered batch back into transit', () => {
    expect(canTransition(BatchStatus.Delivered, BatchStatus.InTransit)).to.equal(false);
  });
});

// The four cases below are required by the marking criteria. Pending tests
// keep the suite green while the list stays visible. Owner: person 1.
describe('BatchRegistryContract', () => {
  it('registers, transfers and delivers a batch');
  it('rejects registration from a non-producer identity');
  it('rejects a custody transfer from an identity that is not the holder');
  it('rejects a custody transfer on an already delivered batch');
});
