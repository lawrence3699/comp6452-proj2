import { expect } from 'chai';
import { summarise, submit } from '../src';

// Phase 0 scaffold check: the module compiles and its public surface is wired.
// Behavioural tests for summarise() land in Phase 1 (the graded aggregation suite).
describe('oracle-service module surface', () => {
  it('exports summarise and submit', () => {
    expect(summarise).to.be.a('function');
    expect(submit).to.be.a('function');
  });
});
