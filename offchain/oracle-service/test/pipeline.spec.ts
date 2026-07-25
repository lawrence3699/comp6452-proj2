import { expect } from 'chai';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { FilesystemBackend, configureBackend, getJson, hashOf } from '@comp6452/offchain-storage';
import { anchorSeries, runOracle } from '../src/pipeline';
import { generateSeries, loadSeries, readSeriesFile } from '../src/readings';
import { Reading, Summary } from '../src/summarise';

const reading = (tempC: number, observedAt: number, batchId = 'BATCH-1'): Reading => ({
  batchId,
  tempC,
  observedAt,
});

/**
 * The pipeline is exercised end to end against a temp-directory storage
 * backend and a sinon spy in place of the gateway, so no Fabric network is
 * required for any of it.
 */
describe('oracle pipeline', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-store-'));
    configureBackend(new FilesystemBackend(root));
  });

  afterEach(async () => {
    configureBackend(undefined);
    await fs.rm(root, { recursive: true, force: true });
    sinon.restore();
  });

  describe('anchorSeries', () => {
    it('stores the raw series and returns a SHA-256 anchor', async () => {
      const readings = [reading(2, 1000), reading(3, 2000)];

      const stored = await anchorSeries('BATCH-1', readings);

      expect(stored.hash).to.match(/^[0-9a-f]{64}$/);
      const fetched = await getJson<{ batchId: string; readings: Reading[] }>(stored.hash);
      expect(fetched.batchId).to.equal('BATCH-1');
      expect(fetched.readings).to.deep.equal(readings);
    });

    it('produces the same anchor for the same series, and a different one otherwise', async () => {
      const a = await anchorSeries('BATCH-1', [reading(2, 1000)]);
      const b = await anchorSeries('BATCH-1', [reading(2, 1000)]);
      const c = await anchorSeries('BATCH-1', [reading(2.01, 1000)]);

      expect(b.hash).to.equal(a.hash);
      expect(c.hash).to.not.equal(a.hash);
    });

    it('refuses an empty series', async () => {
      let thrown: Error | undefined;
      try {
        await anchorSeries('BATCH-1', []);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.message).to.contain('at least one reading');
    });
  });

  describe('runOracle', () => {
    it('stores the raw series then submits the summary with that hash', async () => {
      const submitter = sinon.stub().resolves('tx-1');
      const readings = [reading(2, 1000), reading(4, 2000)];

      const result = await runOracle(readings, submitter);

      expect(submitter.calledOnce).to.equal(true);
      const [summary, rawDataHash] = submitter.firstCall.args as [Summary, string];
      expect(summary.batchId).to.equal('BATCH-1');
      expect(summary.meanC).to.equal(3);
      expect(rawDataHash).to.equal(result.rawDataHash);
    });

    it('anchors bytes that hash to the submitted rawDataHash', async () => {
      const submitter = sinon.stub().resolves('tx-1');

      const result = await runOracle([reading(2, 1000)], submitter);

      const backend = new FilesystemBackend(root);
      const stored = await backend.read(result.rawDataHash);
      expect(stored, 'series must exist in the store').to.not.equal(undefined);
      expect(hashOf(stored as Buffer)).to.equal(result.rawDataHash);
    });

    it('submits one summary per window, all carrying the same series anchor', async () => {
      const submitter = sinon.stub().resolves('tx');
      const readings = [1, 2, 3, 4, 5].map((n) => reading(n, n * 1000));

      const result = await runOracle(readings, submitter, { windowSize: 2 });

      expect(submitter.callCount).to.equal(3);
      expect(result.summaries).to.have.length(3);
      const hashes = submitter.getCalls().map((call) => call.args[1] as string);
      expect(new Set(hashes).size).to.equal(1);
      expect(hashes[0]).to.equal(result.rawDataHash);
    });

    it('submits windows in chronological order so breach counting is meaningful', async () => {
      const submitter = sinon.stub().resolves('tx');
      const readings = [1, 2, 3, 4].map((n) => reading(n, n * 1000));

      await runOracle(readings, submitter, { windowSize: 1 });

      const observed = submitter.getCalls().map((call) => (call.args[0] as Summary).observedAt);
      expect(observed).to.deep.equal([1000, 2000, 3000, 4000]);
    });

    it('rejects a mixed-batch series before storing anything', async () => {
      const submitter = sinon.stub().resolves('tx');

      let thrown: Error | undefined;
      try {
        await runOracle([reading(2, 1000, 'A'), reading(3, 2000, 'B')], submitter);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown?.message).to.contain('single batch');
      expect(submitter.called).to.equal(false);
      // Nothing may be anchored for a series we could never submit.
      expect(await fs.readdir(root)).to.deep.equal([]);
    });

    it('rejects an empty series', async () => {
      let thrown: Error | undefined;
      try {
        await runOracle([], sinon.stub().resolves('tx'));
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.message).to.contain('at least one reading');
    });

    it('propagates a submission failure instead of reporting success', async () => {
      const submitter = sinon.stub().rejects(new Error('peer unavailable'));

      let thrown: Error | undefined;
      try {
        await runOracle([reading(2, 1000)], submitter);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.message).to.contain('peer unavailable');
    });
  });
});

describe('reading sources', () => {
  it('generates a deterministic series', () => {
    const a = generateSeries({ batchId: 'BATCH-X', count: 6 });
    const b = generateSeries({ batchId: 'BATCH-X', count: 6 });

    expect(a).to.deep.equal(b);
    expect(a).to.have.length(6);
    expect(a.every((r) => r.batchId === 'BATCH-X')).to.equal(true);
  });

  it('generates a compliant prefix followed by a sustained excursion', () => {
    const series = generateSeries({ count: 8, excursionFrom: 4, baselineC: 2, excursionC: 9 });

    // Chilled range is 0..4 C, so the prefix is in range and the tail is not.
    expect(series.slice(0, 4).every((r) => r.tempC >= 0 && r.tempC <= 4)).to.equal(true);
    expect(series.slice(4).every((r) => r.tempC > 4)).to.equal(true);
  });

  it('produces strictly increasing timestamps', () => {
    const series = generateSeries({ count: 5, startAt: 1000, intervalSeconds: 60 });

    expect(series.map((r) => r.observedAt)).to.deep.equal([1000, 1060, 1120, 1180, 1240]);
  });

  it('rejects a non-positive count', () => {
    expect(() => generateSeries({ count: 0 })).to.throw('positive integer');
  });

  it('reads a series from a JSON file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-series-'));
    const file = path.join(dir, 'series.json');
    const expected = [reading(2, 1000), reading(3, 2000)];
    await fs.writeFile(file, JSON.stringify(expected));

    try {
      expect(await readSeriesFile(file)).to.deep.equal(expected);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a JSON file whose entries have the wrong shape', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-series-'));
    const file = path.join(dir, 'bad.json');
    await fs.writeFile(file, JSON.stringify([{ batchId: 'B', tempC: 'hot', observedAt: 1 }]));

    let thrown: Error | undefined;
    try {
      await readSeriesFile(file);
    } catch (error) {
      thrown = error as Error;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
    expect(thrown?.message).to.contain('entry 0');
  });

  it('prefers ORACLE_SERIES_FILE over the generated series', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-series-'));
    const file = path.join(dir, 'series.json');
    await fs.writeFile(file, JSON.stringify([reading(7, 4242, 'FROM-FILE')]));
    process.env.ORACLE_SERIES_FILE = file;

    try {
      const series = await loadSeries();
      expect(series).to.have.length(1);
      expect(series[0].batchId).to.equal('FROM-FILE');
    } finally {
      delete process.env.ORACLE_SERIES_FILE;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
