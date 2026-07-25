import { expect } from 'chai';
import {
  Reading,
  formatObservedAt,
  formatTempC,
  reportedTempC,
  round2,
  summarise,
  window,
} from '../src/summarise';

const reading = (tempC: number, observedAt: number, batchId = 'BATCH-1'): Reading => ({
  batchId,
  tempC,
  observedAt,
});

describe('summarise', () => {
  it('aggregates a series into mean, max, min and the latest timestamp', () => {
    const summary = summarise([
      reading(2, 1000),
      reading(4, 1300),
      reading(3, 1600),
    ]);

    expect(summary).to.deep.equal({
      batchId: 'BATCH-1',
      meanC: 3,
      maxC: 4,
      minC: 2,
      observedAt: 1600,
    });
  });

  it('summarises a single reading as itself', () => {
    const summary = summarise([reading(-19.5, 500)]);

    expect(summary.meanC).to.equal(-19.5);
    expect(summary.maxC).to.equal(-19.5);
    expect(summary.minC).to.equal(-19.5);
    expect(summary.observedAt).to.equal(500);
  });

  it('rounds the mean to 2 decimals so the on-chain value is stable', () => {
    // 1/3 + 2/3 + 2/3 style series: the raw mean is a repeating decimal.
    const summary = summarise([reading(1, 10), reading(2, 20), reading(2, 30)]);

    expect(summary.meanC).to.equal(1.67);
    expect(String(summary.meanC).split('.')[1]?.length ?? 0).to.be.at.most(2);
  });

  it('rounds negative means away from zero, not towards it', () => {
    // Math.round(-2.5) is -2; a frozen-goods oracle sits exactly in this region.
    const summary = summarise([reading(-18.005, 10), reading(-18.005, 20)]);

    expect(summary.meanC).to.equal(-18.01);
  });

  it('takes observedAt from the latest reading regardless of input order', () => {
    const summary = summarise([reading(2, 3000), reading(2, 1000), reading(2, 2000)]);

    expect(summary.observedAt).to.equal(3000);
  });

  it('throws on an empty series', () => {
    expect(() => summarise([])).to.throw('at least one reading');
  });

  it('throws when the series spans more than one batch', () => {
    expect(() =>
      summarise([reading(2, 1000, 'BATCH-1'), reading(3, 2000, 'BATCH-2')]),
    ).to.throw('single batch');
  });

  it('names both batch ids in the mixed-batch error', () => {
    expect(() =>
      summarise([reading(2, 1000, 'BATCH-A'), reading(3, 2000, 'BATCH-B')]),
    ).to.throw(/BATCH-A.*BATCH-B/);
  });

  it('rejects a non-finite temperature', () => {
    expect(() => summarise([reading(Number.NaN, 1000)])).to.throw('non-finite tempC');
  });

  it('rejects a missing or non-positive observedAt', () => {
    expect(() => summarise([reading(2, 0)])).to.throw('invalid observedAt');
  });

  it('rejects a reading with an empty batchId', () => {
    expect(() => summarise([reading(2, 1000, '')])).to.throw('no batchId');
  });

  it('does not mutate the input series', () => {
    const readings = [reading(2, 1000), reading(4, 2000)];
    const snapshot = JSON.parse(JSON.stringify(readings)) as Reading[];

    summarise(readings);

    expect(readings).to.deep.equal(snapshot);
  });
});

describe('round2 and wire formatting', () => {
  it('rounds half away from zero in both directions', () => {
    expect(round2(1.005)).to.equal(1.01);
    expect(round2(-1.005)).to.equal(-1.01);
    expect(round2(2.345)).to.equal(2.35);
  });

  it('never produces negative zero', () => {
    expect(Object.is(round2(-0.001), -0)).to.equal(false);
    expect(round2(-0.001)).to.equal(0);
  });

  it('renders temperatures with a fixed 2 decimals for the wire', () => {
    expect(formatTempC(3)).to.equal('3.00');
    expect(formatTempC(-18.456)).to.equal('-18.46');
    // Small magnitudes must not come out in exponential notation.
    expect(formatTempC(0.0000001)).to.equal('0.00');
  });

  it('renders observedAt as an integer unix-seconds string', () => {
    expect(formatObservedAt(1_750_000_000.9)).to.equal('1750000000');
  });
});

describe('reportedTempC', () => {
  const summary = summarise([reading(2, 1000), reading(8, 2000)]);

  it('defaults to the mean', () => {
    expect(reportedTempC(summary)).to.equal(5);
  });

  it('can report the max or the min instead', () => {
    expect(reportedTempC(summary, 'max')).to.equal(8);
    expect(reportedTempC(summary, 'min')).to.equal(2);
  });
});

describe('window', () => {
  it('splits a series into consecutive fixed-size windows', () => {
    const readings = [1, 2, 3, 4, 5].map((n) => reading(n, n * 100));

    const windows = window(readings, 2);

    expect(windows.map((w) => w.length)).to.deep.equal([2, 2, 1]);
    expect(windows[0][0].tempC).to.equal(1);
    expect(windows[2][0].tempC).to.equal(5);
  });

  it('returns one window when the size covers the whole series', () => {
    expect(window([reading(2, 100), reading(3, 200)], 10)).to.have.length(1);
  });

  it('rejects a non-positive window size', () => {
    expect(() => window([reading(2, 100)], 0)).to.throw('positive integer');
  });
});
