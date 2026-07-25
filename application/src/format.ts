/**
 * Console output — owner: person 4.
 *
 * Pure string production, kept out of the command modules so the demo's
 * appearance is unit tested rather than eyeballed. The audience for this
 * output is a marker watching a five-minute screen recording: they will not
 * pause to parse JSON, so every value that matters gets a label.
 */

/** Public batch shape, mirroring `chaincode/batch-registry/src/batch.ts`. */
export interface Batch {
  readonly batchId: string;
  readonly foodType: string;
  readonly producedAt: number;
  readonly shelfLifeDays: number;
  readonly origin: string;
  readonly quantity: number;
  readonly status: string;
  readonly currentHolder: string;
  readonly reportHash: string;
}

/** One entry of `BatchQueryContract:GetBatchHistory`. */
export interface HistoryEntry {
  readonly txId: string;
  readonly timestamp: string;
  readonly isDelete: boolean;
  readonly value: Batch | null;
}

/** One entry of `ComplianceContract:GetReadings`. */
export interface StoredReading {
  readonly batchId: string;
  readonly tempC: number;
  readonly observedAt: number;
  readonly rawDataHash: string;
  readonly breach: boolean;
}

const RULE_WIDTH = 74;

/** A banner an audience can find again when scrubbing back through a recording. */
export const section = (title: string): string => {
  const rule = '='.repeat(RULE_WIDTH);
  return `\n${rule}\n  ${title}\n${rule}`;
};

/** Indented sub-step under a section. */
export const step = (message: string): string => `  -> ${message}`;

/**
 * Abbreviate a transaction id or content hash.
 *
 * A 64-character hex string wraps on a terminal and drowns the line it is on.
 * The first 12 characters are enough to match a transaction against the peer
 * log by eye, and the full value is always available from the ledger.
 */
export const shortHash = (value: string, keep = 12): string => {
  if (keep <= 0) {
    throw new Error('shortHash requires a positive number of characters');
  }
  return value.length <= keep ? value : `${value.slice(0, keep)}...`;
};

/** Unix seconds as a UTC timestamp. Fabric records seconds; humans read dates. */
export const formatUnixSeconds = (seconds: number): string => {
  if (!Number.isFinite(seconds)) {
    return String(seconds);
  }
  return new Date(Math.trunc(seconds) * 1000).toISOString().replace('.000Z', 'Z');
};

/** One-line summary of a batch, for progress output. */
export const formatBatchLine = (batch: Batch): string =>
  `${batch.batchId}  ${batch.status.padEnd(12)} holder=${batch.currentHolder}  ` +
  `${batch.foodType} x${String(batch.quantity)}`;

/** Multi-line detail view of a batch, for the regulator's read-back. */
export const formatBatch = (batch: Batch): string =>
  [
    `  batch id      ${batch.batchId}`,
    `  food type     ${batch.foodType}`,
    `  produced at   ${formatUnixSeconds(batch.producedAt)}`,
    `  shelf life    ${String(batch.shelfLifeDays)} days`,
    `  origin        ${batch.origin === '' ? '(not recorded)' : batch.origin}`,
    `  quantity      ${String(batch.quantity)}`,
    `  status        ${batch.status}`,
    `  held by       ${batch.currentHolder}`,
    `  report hash   ${batch.reportHash === '' ? '(none attached)' : batch.reportHash}`,
  ].join('\n');

/**
 * Render the custody history as a numbered trail.
 *
 * This is the FR2 traceability deliverable made legible: each ledger version
 * of the key, oldest first, with the status it carried and who held it. A
 * deletion tombstone carries no value, so it is labelled rather than skipped —
 * an audit trail that hides its own gaps is not an audit trail.
 */
export const formatHistory = (entries: readonly HistoryEntry[]): string => {
  if (entries.length === 0) {
    return '  (no history — the batch id has never been written)';
  }
  return entries
    .map((entry, index) => {
      const position = String(index + 1).padStart(2, ' ');
      const head = `  ${position}. ${entry.timestamp}  tx ${shortHash(entry.txId)}`;
      if (entry.value === null) {
        return `${head}\n      ${entry.isDelete ? 'DELETED' : '(empty value)'}`;
      }
      return (
        `${head}\n      status ${entry.value.status.padEnd(12)} ` +
        `holder ${entry.value.currentHolder}`
      );
    })
    .join('\n');
};

/** Render the temperature readings the oracle anchored, marking breaches. */
export const formatReadings = (readings: readonly StoredReading[]): string => {
  if (readings.length === 0) {
    return '  (no temperature readings recorded)';
  }
  return readings
    .map((reading) => {
      const marker = reading.breach ? 'BREACH ' : 'in range';
      return (
        `  ${formatUnixSeconds(reading.observedAt)}  ${String(reading.tempC).padStart(7)}C  ` +
        `${marker}  evidence ${shortHash(reading.rawDataHash)}`
      );
    })
    .join('\n');
};

/** Render a holder's current inventory. */
export const formatHolderInventory = (holder: string, batches: readonly Batch[]): string => {
  if (batches.length === 0) {
    return `  ${holder} currently holds no batches`;
  }
  return [
    `  ${holder} currently holds ${String(batches.length)} batch(es):`,
    ...batches.map((batch) => `    ${formatBatchLine(batch)}`),
  ].join('\n');
};

/**
 * A batch id that is unique per run but still readable on screen.
 *
 * The demo is re-runnable, and `RegisterBatch` rejects a duplicate id, so a
 * fixed id would make the second run of the day fail on the first step. The
 * prefix keeps the ids greppable; the seconds-resolution suffix keeps them
 * short enough to read out loud.
 */
export const generateBatchId = (prefix = 'BATCH', now: number = Date.now()): string =>
  `${prefix}-${String(Math.trunc(now / 1000))}`;
