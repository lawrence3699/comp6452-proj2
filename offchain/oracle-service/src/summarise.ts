/**
 * Off-chain aggregation — owner: person 3.
 *
 * This is the "off-chain computation" half of the oracle: a whole series of
 * raw sensor readings is reduced here, and only the summary crosses onto the
 * ledger. Pure functions, no I/O, so the whole thing is unit tested without a
 * network.
 */

export interface Reading {
  readonly batchId: string;
  readonly tempC: number;
  readonly observedAt: number;
}

export interface Summary {
  readonly batchId: string;
  readonly meanC: number;
  readonly maxC: number;
  readonly minC: number;
  readonly observedAt: number;
}

/**
 * Multiply by a power of ten by editing the decimal exponent of the number's
 * own string form, rather than by arithmetic.
 *
 * `1.005 * 100` evaluates to 100.49999999999999 in binary floating point, so
 * the naive scale-round-unscale silently rounds 1.005 down to 1.00. Shifting
 * the exponent of the shortest round-trip decimal representation avoids the
 * multiplication entirely. `toExponential()` (rather than `toString()`) is
 * used because values that already stringify exponentially — 1e-7 — would
 * otherwise produce a malformed literal.
 */
const shiftExponent = (value: number, by: number): number => {
  const [mantissa, exponent] = value.toExponential().split('e');
  return Number(`${mantissa}e${String(Number(exponent) + by)}`);
};

/**
 * Round half away from zero to 2 decimals.
 *
 * Rounding on the magnitude and re-applying the sign keeps the behaviour
 * symmetric: `Math.round` alone breaks ties towards +Infinity, so -18.005
 * would round to -18.00 while 18.005 rounds to 18.01. A frozen-goods oracle
 * sits at exactly -18 C, so that asymmetry lands right on the threshold.
 */
export const round2 = (value: number): number => {
  if (!Number.isFinite(value)) {
    throw new Error(`round2 requires a finite number, got ${String(value)}`);
  }
  const magnitude = Math.abs(value);
  if (magnitude === 0) {
    return 0;
  }
  const rounded = shiftExponent(Math.round(shiftExponent(magnitude, 2)), -2);
  // `+ 0` normalises -0 to 0 so the string sent on chain is never "-0.00".
  return (value < 0 ? -rounded : rounded) + 0;
};

/**
 * Fixed 2-decimal rendering for the wire. Chaincode arguments are strings, and
 * a fixed shape means every peer parses the identical value — no locale, no
 * exponential notation for small magnitudes, no drift between runs.
 */
export const formatTempC = (value: number): string => round2(value).toFixed(2);

/** Unix seconds as an integer string, which is what the chaincode parses. */
export const formatObservedAt = (value: number): string => String(Math.trunc(value));

const assertValidReading = (reading: Reading, index: number): void => {
  if (typeof reading.batchId !== 'string' || reading.batchId === '') {
    throw new Error(`reading ${index} has no batchId`);
  }
  if (!Number.isFinite(reading.tempC)) {
    throw new Error(`reading ${index} for ${reading.batchId} has a non-finite tempC`);
  }
  if (!Number.isFinite(reading.observedAt) || reading.observedAt <= 0) {
    throw new Error(
      `reading ${index} for ${reading.batchId} has an invalid observedAt: ${String(reading.observedAt)}`,
    );
  }
};

/**
 * Reduce a series of readings for one batch to the summary that gets anchored
 * on chain.
 *
 * Rules, all of which the tests pin:
 * - an empty series throws: submitting a summary of nothing would assert
 *   compliance we never observed;
 * - a series spanning more than one batch throws, because the on-chain call
 *   takes a single batchId and silently picking one would attribute another
 *   batch's temperatures to it;
 * - `observedAt` is the latest reading's timestamp, so the ledger records when
 *   the window ended, not when the oracle happened to run;
 * - `meanC` is rounded to 2 decimals so the value written on chain is stable
 *   across runs and across machines.
 */
export const summarise = (readings: readonly Reading[]): Summary => {
  if (readings.length === 0) {
    throw new Error('summarise requires at least one reading');
  }

  const batchId = readings[0].batchId;
  let sum = 0;
  let maxC = Number.NEGATIVE_INFINITY;
  let minC = Number.POSITIVE_INFINITY;
  let observedAt = 0;

  readings.forEach((reading, index) => {
    assertValidReading(reading, index);
    if (reading.batchId !== batchId) {
      throw new Error(
        `summarise requires a single batch, got ${batchId} and ${reading.batchId}`,
      );
    }
    sum += reading.tempC;
    maxC = Math.max(maxC, reading.tempC);
    minC = Math.min(minC, reading.tempC);
    observedAt = Math.max(observedAt, reading.observedAt);
  });

  return {
    batchId,
    meanC: round2(sum / readings.length),
    maxC: round2(maxC),
    minC: round2(minC),
    observedAt: Math.trunc(observedAt),
  };
};

/** Which summary statistic is reported to the chaincode as `tempC`. */
export type ReportedStat = 'mean' | 'max' | 'min';

/**
 * `SubmitTemperatureReading` takes exactly one `tempC`, so the oracle has to
 * choose which statistic represents the window.
 *
 * The default is the mean: it is the honest summary of the window and it is
 * what the breach counter is designed around (a single stray sample should not
 * flag a batch — that is what VIOLATIONS_BEFORE_FLAG = 3 consecutive windows
 * is for). A deployment that would rather be paranoid about short excursions
 * can set ORACLE_REPORT_STAT=max, since the chaincode cannot tell the
 * difference. Either way the full series is anchored by `rawDataHash`, so an
 * auditor can recompute any statistic and check it against the ledger.
 */
export const reportedTempC = (summary: Summary, stat: ReportedStat = 'mean'): number => {
  switch (stat) {
    case 'max':
      return summary.maxC;
    case 'min':
      return summary.minC;
    default:
      return summary.meanC;
  }
};

/** Parse ORACLE_REPORT_STAT, falling back to the mean on anything unrecognised. */
export const reportedStatFromEnv = (): ReportedStat => {
  const configured = (process.env.ORACLE_REPORT_STAT ?? '').toLowerCase();
  return configured === 'max' || configured === 'min' ? configured : 'mean';
};

/**
 * Split a series into fixed-size consecutive windows, each of which becomes
 * one on-chain submission. The compliance chaincode flags a batch after
 * VIOLATIONS_BEFORE_FLAG consecutive breaching submissions, so the window size
 * is what sets how long a breach must persist before it counts.
 */
export const window = (readings: readonly Reading[], size: number): Reading[][] => {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`window size must be a positive integer, got ${String(size)}`);
  }
  const windows: Reading[][] = [];
  for (let i = 0; i < readings.length; i += size) {
    windows.push(readings.slice(i, i + size));
  }
  return windows;
};
