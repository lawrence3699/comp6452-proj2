import { expect } from 'chai';
import { summarise, Reading } from '../src';

const reading = (tempC: number, observedAt: number, batchId = 'BATCH-1'): Reading => ({
  batchId,
  tempC,
  observedAt,
});

describe('summarise', () => {
  it('rejects an empty window', () => {
    expect(() => summarise([])).to.throw(/at least one reading/);
  });

  it('rejects a window that mixes batches', () => {
    const readings = [reading(2, 100, 'BATCH-1'), reading(3, 200, 'BATCH-2')];
    expect(() => summarise(readings)).to.throw(/one batch per window/);
  });

  it('summarises a single reading as its own mean, max and min', () => {
    const result = summarise([reading(3.5, 1000)]);
    expect(result).to.deep.equal({
      batchId: 'BATCH-1',
      meanC: 3.5,
      maxC: 3.5,
      minC: 3.5,
      observedAt: 1000,
    });
  });

  it('computes mean, max and min across a window', () => {
    const result = summarise([reading(2, 100), reading(4, 200), reading(6, 300)]);
    expect(result.meanC).to.equal(4);
    expect(result.maxC).to.equal(6);
    expect(result.minC).to.equal(2);
  });

  it('reports the latest observation as the window timestamp', () => {
    const result = summarise([reading(2, 300), reading(4, 100), reading(6, 200)]);
    expect(result.observedAt).to.equal(300);
  });

  it('is independent of input order', () => {
    const ascending = summarise([reading(2, 100), reading(4, 200), reading(6, 300)]);
    const shuffled = summarise([reading(6, 300), reading(2, 100), reading(4, 200)]);
    expect(shuffled).to.deep.equal(ascending);
  });

  it('handles sub-zero frozen-chain readings', () => {
    const result = summarise([reading(-20, 100), reading(-22, 200), reading(-18, 300)]);
    expect(result.meanC).to.equal(-20);
    expect(result.maxC).to.equal(-18);
    expect(result.minC).to.equal(-22);
  });

  it('rounds the mean to two decimal places', () => {
    const result = summarise([reading(0, 100), reading(0, 200), reading(1, 300)]);
    expect(result.meanC).to.equal(0.33);
  });
});
