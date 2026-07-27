/**
 * Oracle service — owner: person 3.
 *
 * Reads raw temperature observations, aggregates them off chain, stores the
 * raw series through the storage adapter, and submits only the summary plus
 * the storage hash to coldchain-compliance.
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

/** Round to two decimal places to keep the on-chain value stable and readable. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Aggregate a window of raw readings for a single batch into one summary.
 *
 * Pure and network-free so it can be unit tested without a Fabric network —
 * this is the core of the off-chain computation requirement.
 *
 * - `meanC` is rounded to two decimals; `maxC`/`minC` are the observed extremes.
 * - `observedAt` is the latest observation in the window (when it closes).
 * - The order of the input does not affect the result.
 *
 * @throws if the window is empty or mixes readings from different batches.
 */
export const summarise = (readings: readonly Reading[]): Summary => {
  if (readings.length === 0) {
    throw new Error('summarise requires at least one reading');
  }

  const batchId = readings[0].batchId;
  for (const reading of readings) {
    if (reading.batchId !== batchId) {
      throw new Error(
        `summarise expects one batch per window, saw '${batchId}' and '${reading.batchId}'`,
      );
    }
  }

  let sum = 0;
  let maxC = readings[0].tempC;
  let minC = readings[0].tempC;
  let observedAt = readings[0].observedAt;
  for (const reading of readings) {
    sum += reading.tempC;
    if (reading.tempC > maxC) maxC = reading.tempC;
    if (reading.tempC < minC) minC = reading.tempC;
    if (reading.observedAt > observedAt) observedAt = reading.observedAt;
  }

  return {
    batchId,
    meanC: round2(sum / readings.length),
    maxC,
    minC,
    observedAt,
  };
};

// TODO(person 3, Phase 2): submit through the Fabric gateway using the oracle
// identity, calling SubmitTemperatureReading on coldchain-compliance. Requires
// the oracle identity to carry the 'oracle' attribute that assertOracle checks
// (coordinate with persons 2 & 4).
export const submit = async (_summary: Summary, _rawDataHash: string): Promise<void> => {
  throw new Error('not implemented');
};
