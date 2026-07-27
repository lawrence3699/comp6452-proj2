import { expect } from 'chai';
import { put, get } from '../src';

// Phase 0 scaffold check: the module compiles and its public surface is wired.
// Behavioural tests (hashing, tamper detection) land in Phase 1.
describe('storage module surface', () => {
  it('exports put and get', () => {
    expect(put).to.be.a('function');
    expect(get).to.be.a('function');
  });
});
