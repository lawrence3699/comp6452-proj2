/**
 * Oracle service — owner: person 3.
 *
 * Reads raw temperature observations, aggregates them off chain, stores the
 * raw series through the storage adapter, and submits only the summary plus
 * the storage hash to coldchain-compliance.
 *
 * Three of the Task 3 requirements meet here: the oracle (data the ledger
 * cannot fetch itself), off-chain computation (`summarise`, which reduces a
 * whole series to four numbers so the ledger stores a summary rather than a
 * stream), and off-chain storage (the raw series, anchored by `rawDataHash`).
 */

export { Reading, Summary, ReportedStat } from './summarise';
export {
  formatObservedAt,
  formatTempC,
  reportedStatFromEnv,
  reportedTempC,
  round2,
  summarise,
  window,
} from './summarise';

export {
  complianceContractName,
  oracleConfig,
  submit,
  submitAll,
  submitWith,
} from './submit';

export {
  DEFAULT_SERIES,
  SeriesOptions,
  generateSeries,
  loadSeries,
  readSeriesFile,
} from './readings';

export { OracleRunResult, anchorSeries, runOracle } from './pipeline';
