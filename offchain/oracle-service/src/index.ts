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

/**
 * The chaincode entry point takes a single tempC, so we send the window mean as
 * the representative aggregate. Switch to `summary.maxC` if person 2 wants the
 * worst-case excursion to drive flagging — this is the one line to change
 * (coordination item, see docs/interfaces.md §4).
 */
export const representativeTempC = (summary: Summary): number => summary.meanC;

/** Map a summary + storage hash to the ordered string args the chaincode expects. */
export const toReadingArgs = (summary: Summary, rawDataHash: string): string[] => [
  summary.batchId,
  String(representativeTempC(summary)),
  String(summary.observedAt),
  rawDataHash,
];

/** Anything that can submit a named transaction: a fabric-gateway Contract, or a test double. */
export interface ChaincodeSubmitter {
  submitTransaction(name: string, ...args: string[]): Promise<Uint8Array>;
}

/** The slice of the storage adapter the oracle needs, injected to avoid a hard package dependency. */
export interface RawSeriesStore {
  put(payload: Buffer, contentType: string): Promise<{ readonly hash: string }>;
}

/** Submit one aggregated reading to coldchain-compliance's SubmitTemperatureReading. */
export const submitVia = async (
  submitter: ChaincodeSubmitter,
  summary: Summary,
  rawDataHash: string,
): Promise<void> => {
  await submitter.submitTransaction(
    'SubmitTemperatureReading',
    ...toReadingArgs(summary, rawDataHash),
  );
};

/**
 * One full oracle cycle: aggregate a window, persist the raw series off chain,
 * then submit the summary anchored by the raw-series hash. Pure orchestration —
 * the store and submitter are injected, so this is unit tested without a network.
 */
export const runOracleCycle = async (
  readings: readonly Reading[],
  store: RawSeriesStore,
  submitter: ChaincodeSubmitter,
): Promise<Summary> => {
  const summary = summarise(readings);
  const { hash } = await store.put(Buffer.from(JSON.stringify(readings)), 'application/json');
  await submitVia(submitter, summary, hash);
  return summary;
};

/**
 * Default entry point: connect to Fabric with the oracle identity and submit.
 *
 * The gateway wiring lives in ./gateway and is imported lazily, so the pure
 * logic above (and its tests) never pull in fabric-gateway. This path is
 * UNVERIFIED until the test network is up and person 4 supplies the connection
 * config, and it needs the oracle identity to carry the 'oracle' attribute that
 * assertOracle checks (coordination item with persons 2 & 4).
 */
export const submit = async (summary: Summary, rawDataHash: string): Promise<void> => {
  const { connectOracleSubmitter } = await import('./gateway');
  const { submitter, close } = await connectOracleSubmitter();
  try {
    await submitVia(submitter, summary, rawDataHash);
  } finally {
    close();
  }
};
