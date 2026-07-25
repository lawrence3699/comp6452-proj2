/**
 * Reading sources — owner: person 3.
 *
 * The demo needs a series to submit. Real deployments read from a sensor
 * gateway; here we either load a JSON file or generate a deterministic one, so
 * `npm run demo` produces the same story every time it is shown to a marker.
 */

import { promises as fs } from 'fs';
import { Reading } from './summarise';

/** Load a JSON array of readings from disk, validating the shape. */
export const readSeriesFile = async (filePath: string): Promise<Reading[]> => {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON array of readings`);
  }
  return parsed.map((entry, index) => {
    const record = entry as Partial<Reading>;
    if (
      typeof record.batchId !== 'string' ||
      typeof record.tempC !== 'number' ||
      typeof record.observedAt !== 'number'
    ) {
      throw new Error(
        `${filePath} entry ${index} must be { batchId: string, tempC: number, observedAt: number }`,
      );
    }
    return { batchId: record.batchId, tempC: record.tempC, observedAt: record.observedAt };
  });
};

export interface SeriesOptions {
  readonly batchId: string;
  /** Number of readings to produce. */
  readonly count: number;
  /** Unix seconds of the first reading. */
  readonly startAt: number;
  /** Seconds between consecutive readings. */
  readonly intervalSeconds: number;
  /** Temperature the series holds while in range. */
  readonly baselineC: number;
  /** Temperature the series holds once the excursion starts. */
  readonly excursionC: number;
  /** Index at which the excursion begins; >= count means "no excursion". */
  readonly excursionFrom: number;
}

export const DEFAULT_SERIES: SeriesOptions = {
  batchId: 'BATCH-DEMO-1',
  count: 12,
  startAt: 1_750_000_000,
  intervalSeconds: 300,
  // Chilled range is 0..4 C (see coldchain-compliance/src/thresholds.ts), so
  // 2 C is comfortably compliant and 9 C is an unambiguous breach.
  baselineC: 2,
  excursionC: 9,
  excursionFrom: 6,
};

/**
 * Deterministic synthetic series: compliant readings, then a sustained
 * excursion. No Math.random — a demo that flags a batch only sometimes is
 * worse than no demo, and a fixed series means the resulting rawDataHash is
 * reproducible and can be checked by hand.
 *
 * A small triangular wobble is added so the mean is not trivially equal to the
 * baseline, which would hide a rounding bug in `summarise`.
 */
export const generateSeries = (options: Partial<SeriesOptions> = {}): Reading[] => {
  const opts: SeriesOptions = { ...DEFAULT_SERIES, ...options };
  if (!Number.isInteger(opts.count) || opts.count <= 0) {
    throw new Error(`series count must be a positive integer, got ${String(opts.count)}`);
  }
  return Array.from({ length: opts.count }, (_unused, index) => {
    const base = index >= opts.excursionFrom ? opts.excursionC : opts.baselineC;
    const wobble = ((index % 3) - 1) / 10;
    return {
      batchId: opts.batchId,
      tempC: Number((base + wobble).toFixed(2)),
      observedAt: opts.startAt + index * opts.intervalSeconds,
    };
  });
};

/**
 * Resolve the series for a run: `ORACLE_SERIES_FILE` if set, otherwise a
 * generated one. Keeps `run.ts` free of branching.
 */
export const loadSeries = async (options: Partial<SeriesOptions> = {}): Promise<Reading[]> => {
  const file = process.env.ORACLE_SERIES_FILE;
  if (file !== undefined && file !== '') {
    return readSeriesFile(file);
  }
  return generateSeries(options);
};
