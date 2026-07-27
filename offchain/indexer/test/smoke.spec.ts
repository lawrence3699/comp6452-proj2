import { expect } from 'chai';
import { listen, historyFor } from '../src';

// Phase 0 scaffold check: the module compiles and its public surface is wired.
// Behavioural tests (persistence, per-batch query) land in Phase 1.
describe('indexer module surface', () => {
  it('exports listen and historyFor', () => {
    expect(listen).to.be.a('function');
    expect(historyFor).to.be.a('function');
  });
});
