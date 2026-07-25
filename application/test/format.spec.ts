import { expect } from 'chai';
import {
  Batch,
  HistoryEntry,
  StoredReading,
  formatBatch,
  formatBatchLine,
  formatHistory,
  formatHolderInventory,
  formatReadings,
  formatUnixSeconds,
  generateBatchId,
  section,
  shortHash,
} from '../src/format';

const batch = (overrides: Partial<Batch> = {}): Batch => ({
  batchId: 'BATCH-1',
  foodType: 'chilled',
  producedAt: 1_700_000_000,
  shelfLifeDays: 14,
  origin: 'Riverina NSW',
  quantity: 500,
  status: 'CREATED',
  currentHolder: 'Org1MSP',
  reportHash: 'a'.repeat(64),
  ...overrides,
});

describe('shortHash', () => {
  it('truncates a 64-character hash so it fits on one terminal line', () => {
    expect(shortHash('a'.repeat(64))).to.equal(`${'a'.repeat(12)}...`);
  });

  it('leaves a value shorter than the limit alone', () => {
    expect(shortHash('abc')).to.equal('abc');
  });

  it('rejects a non-positive keep length rather than returning "..."', () => {
    expect(() => shortHash('abcdef', 0)).to.throw(/positive number of characters/);
  });
});

describe('formatUnixSeconds', () => {
  it('renders unix seconds as a readable UTC timestamp', () => {
    expect(formatUnixSeconds(1_700_000_000)).to.equal('2023-11-14T22:13:20Z');
  });

  it('passes a non-finite value straight through instead of printing Invalid Date', () => {
    expect(formatUnixSeconds(Number.NaN)).to.equal('NaN');
  });
});

describe('formatBatch', () => {
  it('labels every field so the output needs no legend', () => {
    const rendered = formatBatch(batch());
    expect(rendered).to.contain('batch id      BATCH-1');
    expect(rendered).to.contain('status        CREATED');
    expect(rendered).to.contain('held by       Org1MSP');
  });

  it('says so explicitly when no report is anchored', () => {
    expect(formatBatch(batch({ reportHash: '' }))).to.contain('(none attached)');
  });

  it('says so explicitly when no origin was recorded', () => {
    expect(formatBatch(batch({ origin: '' }))).to.contain('(not recorded)');
  });

  it('never leaks private fields — the public record has none to leak', () => {
    const rendered = formatBatch(batch());
    expect(rendered.toLowerCase()).to.not.contain('unitprice');
    expect(rendered.toLowerCase()).to.not.contain('unit price');
  });
});

describe('formatBatchLine', () => {
  it('fits the batch onto a single aligned line', () => {
    const line = formatBatchLine(batch());
    expect(line).to.contain('BATCH-1');
    expect(line).to.contain('CREATED');
    expect(line).to.contain('holder=Org1MSP');
    expect(line.split('\n')).to.have.length(1);
  });
});

describe('formatHistory', () => {
  const entry = (status: string, txId: string, timestamp: string): HistoryEntry => ({
    txId,
    timestamp,
    isDelete: false,
    value: batch({ status }),
  });

  it('numbers the trail and shows the status each version carried', () => {
    const rendered = formatHistory([
      entry('CREATED', 'a'.repeat(64), '2026-07-25T03:00:00.000Z'),
      entry('IN_TRANSIT', 'b'.repeat(64), '2026-07-25T03:05:00.000Z'),
    ]);
    expect(rendered).to.contain(' 1. 2026-07-25T03:00:00.000Z');
    expect(rendered).to.contain(' 2. 2026-07-25T03:05:00.000Z');
    expect(rendered).to.contain('status CREATED');
    expect(rendered).to.contain('status IN_TRANSIT');
  });

  it('labels a deletion tombstone rather than dropping it from the trail', () => {
    const rendered = formatHistory([
      { txId: 'c'.repeat(64), timestamp: '2026-07-25T03:00:00.000Z', isDelete: true, value: null },
    ]);
    expect(rendered).to.contain('DELETED');
  });

  it('explains an empty history instead of printing nothing', () => {
    expect(formatHistory([])).to.contain('no history');
  });
});

describe('formatReadings', () => {
  const reading = (tempC: number, breach: boolean): StoredReading => ({
    batchId: 'BATCH-1',
    tempC,
    observedAt: 1_700_000_000,
    rawDataHash: 'd'.repeat(64),
    breach,
  });

  it('marks breaching readings distinctly from in-range ones', () => {
    const rendered = formatReadings([reading(2, false), reading(9, true)]);
    expect(rendered).to.contain('in range');
    expect(rendered).to.contain('BREACH');
  });

  it('explains an empty series instead of printing nothing', () => {
    expect(formatReadings([])).to.contain('no temperature readings');
  });
});

describe('formatHolderInventory', () => {
  it('counts what the holder has', () => {
    const rendered = formatHolderInventory('Org2MSP', [batch(), batch({ batchId: 'BATCH-2' })]);
    expect(rendered).to.contain('Org2MSP currently holds 2 batch(es)');
    expect(rendered).to.contain('BATCH-2');
  });

  it('says so when a holder has nothing', () => {
    expect(formatHolderInventory('Org2MSP', [])).to.contain('holds no batches');
  });
});

describe('generateBatchId', () => {
  it('embeds the timestamp in seconds so ids stay short and sortable', () => {
    expect(generateBatchId('BATCH', 1_700_000_000_000)).to.equal('BATCH-1700000000');
  });

  it('produces a different id a second later, which is what makes the demo re-runnable', () => {
    // RegisterBatch rejects a duplicate id, so a fixed id would make the second
    // run of the demo fail on its very first step.
    const first = generateBatchId('BATCH', 1_700_000_000_000);
    const second = generateBatchId('BATCH', 1_700_000_001_000);
    expect(first).to.not.equal(second);
  });
});

describe('section', () => {
  it('surrounds the title with rules an audience can spot when scrubbing back', () => {
    const lines = section('PRODUCER registers a batch').split('\n');
    expect(lines[1]).to.match(/^=+$/);
    expect(lines[2]).to.contain('PRODUCER registers a batch');
    expect(lines[3]).to.match(/^=+$/);
  });
});
