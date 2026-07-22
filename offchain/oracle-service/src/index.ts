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

// TODO(person 3): pure aggregation, unit tested without a network.
export const summarise = (_readings: readonly Reading[]): Summary => {
  throw new Error('not implemented');
};

// TODO(person 3): submit through the Fabric gateway using the oracle identity,
// calling SubmitTemperatureReading on coldchain-compliance.
export const submit = async (_summary: Summary, _rawDataHash: string): Promise<void> => {
  throw new Error('not implemented');
};
