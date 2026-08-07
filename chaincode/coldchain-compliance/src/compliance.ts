import { Context, Contract } from 'fabric-contract-api';
import { VIOLATIONS_BEFORE_FLAG, isBreach } from './thresholds';
import { assertOracle, assertRegulator } from './oracleIdentity';
import { cascadeRecall } from './recall';

export const REGISTRY_CHAINCODE = 'batch-registry';
export const CHANNEL = 'mychannel';

/** Composite key under which each accepted reading is stored. */
export const READING_INDEX = 'reading~batchId~observedAt';

/** Plain key holding the running breach counter for a batch. */
const breachKey = (batchId: string): string => `breachCount~${batchId}`;

/**
 * Lowercase hex SHA-256, the only shape a rawDataHash may take.
 *
 * The hash is the sole link between the on-chain record and the off-chain raw
 * temperature series; anchoring a malformed value produces "evidence" nobody
 * can ever check against anything.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Transaction time in unix seconds.
 *
 * Every endorsing peer must compute an identical write set or the transaction
 * fails validation, so wall-clock sources such as Date.now() are unusable here:
 * two endorsers would disagree. getTxTimestamp comes from the proposal and is
 * therefore the same value on every peer.
 */
const txTimeSeconds = (ctx: Context): number => {
  const ts = ctx.stub.getTxTimestamp();
  return Number(ts.seconds);
};

interface StoredReading {
  readonly batchId: string;
  readonly tempC: number;
  readonly observedAt: number;
  readonly rawDataHash: string;
  readonly breach: boolean;
}

/** Minimal shape this chaincode needs from a batch-registry batch. */
interface RegistryBatch {
  readonly batchId: string;
  readonly foodType: string;
  readonly status: string;
}

/**
 * Read a batch from the registry chaincode.
 *
 * Both chaincodes sit on the same channel, so invokeChaincode runs in the
 * caller's transaction context and needs no separate endorsement round.
 */
const fetchBatch = async (ctx: Context, batchId: string): Promise<RegistryBatch> => {
  const response = await ctx.stub.invokeChaincode(
    REGISTRY_CHAINCODE,
    ['BatchRegistryContract:GetBatch', batchId],
    CHANNEL,
  );

  if (response.status !== 200) {
    throw new Error(
      `could not read batch ${batchId} from ${REGISTRY_CHAINCODE}: ${response.message}`,
    );
  }

  // A 200 with no payload means the registry answered but the batch is absent;
  // parsing an empty buffer would throw a confusing SyntaxError instead.
  if (!response.payload || response.payload.length === 0) {
    throw new Error(`batch ${batchId} not found in ${REGISTRY_CHAINCODE}`);
  }

  return JSON.parse(response.payload.toString()) as RegistryBatch;
};

/**
 * FR3 problem batch marking, driven by oracle temperature readings.
 * Owner: person 2.
 */
export class ComplianceContract extends Contract {
  /**
   * Record a temperature reading and flag the batch once the cold chain has
   * been breached often enough in a row.
   *
   * Consecutive is the operative word: a single freak reading from a sensor
   * opening a door should not condemn a shipment, but three in a row is a real
   * excursion. A reading back inside range resets the counter.
   */
  public async SubmitTemperatureReading(
    ctx: Context,
    batchId: string,
    tempC: string,
    observedAt: string,
    rawDataHash: string,
  ): Promise<void> {
    assertOracle(ctx);

    if (!batchId) {
      throw new Error('SubmitTemperatureReading: batchId is required');
    }

    // Every chaincode argument arrives as a string; a NaN here would silently
    // poison the comparison against the threshold range.
    const temperature = Number(tempC);
    if (!Number.isFinite(temperature)) {
      throw new Error(`SubmitTemperatureReading: tempC '${tempC}' is not a number`);
    }

    const observed = Number(observedAt);
    if (!Number.isFinite(observed)) {
      throw new Error(`SubmitTemperatureReading: observedAt '${observedAt}' is not a number`);
    }

    if (!SHA256_HEX.test(rawDataHash)) {
      throw new Error(
        `SubmitTemperatureReading: rawDataHash '${rawDataHash}' must be a ` +
          'lowercase hex SHA-256 (64 hex characters) — it is the only link to ' +
          'the off-chain raw series, and a malformed hash anchors evidence ' +
          'nobody can check',
      );
    }

    const batch = await fetchBatch(ctx, batchId);
    const breached = isBreach(batch.foodType, temperature);

    const reading: StoredReading = {
      batchId,
      tempC: temperature,
      observedAt: observed,
      rawDataHash,
      breach: breached,
    };

    await ctx.stub.putState(
      ctx.stub.createCompositeKey(READING_INDEX, [batchId, String(observed)]),
      Buffer.from(JSON.stringify(reading)),
    );

    const counterKey = breachKey(batchId);

    if (!breached) {
      // Back in range — the excursion is over, start counting again.
      await ctx.stub.putState(counterKey, Buffer.from('0'));
      return;
    }

    const raw = await ctx.stub.getState(counterKey);
    const previous = raw && raw.length > 0 ? Number(raw.toString()) : 0;
    const consecutive = (Number.isFinite(previous) ? previous : 0) + 1;

    await ctx.stub.putState(counterKey, Buffer.from(String(consecutive)));

    if (consecutive < VIOLATIONS_BEFORE_FLAG) {
      return;
    }

    // Already flagged or recalled: nothing left to escalate. The registry also
    // treats this as a no-op, but skipping the call keeps the write set small.
    if (batch.status === 'FLAGGED' || batch.status === 'RECALLED') {
      return;
    }

    const reason =
      `cold chain breach: ${consecutive} consecutive readings outside the ` +
      `${batch.foodType} range, latest ${temperature}C`;

    const response = await ctx.stub.invokeChaincode(
      REGISTRY_CHAINCODE,
      ['BatchRegistryContract:FlagBatch', batchId, reason, rawDataHash],
      CHANNEL,
    );

    if (response.status !== 200) {
      throw new Error(`failed to flag batch ${batchId}: ${response.message}`);
    }

    ctx.stub.setEvent(
      'ComplianceBreach',
      Buffer.from(
        JSON.stringify({
          batchId,
          consecutive,
          tempC: temperature,
          rawDataHash,
          timestamp: txTimeSeconds(ctx),
        }),
      ),
    );
  }

  /** Manual regulator path, independent of the oracle. */
  public async FlagByRegulator(
    ctx: Context,
    batchId: string,
    reason: string,
    evidenceHash: string,
  ): Promise<void> {
    assertRegulator(ctx);

    if (!reason) {
      throw new Error('FlagByRegulator: reason is required');
    }

    const response = await ctx.stub.invokeChaincode(
      REGISTRY_CHAINCODE,
      ['BatchRegistryContract:FlagBatch', batchId, reason, evidenceHash],
      CHANNEL,
    );

    if (response.status !== 200) {
      throw new Error(`failed to flag batch ${batchId}: ${response.message}`);
    }
  }

  /**
   * Recall a batch and every batch derived from it.
   *
   * Returns the recalled ids as JSON so the regulator sees the blast radius.
   */
  public async RecallBatch(ctx: Context, batchId: string): Promise<string> {
    assertRegulator(ctx);

    const recalled = await cascadeRecall(ctx, batchId);

    ctx.stub.setEvent(
      'RecallCascaded',
      Buffer.from(JSON.stringify({ root: batchId, recalled, timestamp: txTimeSeconds(ctx) })),
    );

    return JSON.stringify(recalled);
  }

  /** Current consecutive-breach count, for dashboards and the demo. */
  public async GetBreachCount(ctx: Context, batchId: string): Promise<number> {
    const raw = await ctx.stub.getState(breachKey(batchId));
    if (!raw || raw.length === 0) {
      return 0;
    }
    const value = Number(raw.toString());
    return Number.isFinite(value) ? value : 0;
  }

  /** All readings recorded for a batch, oldest first. */
  public async GetReadings(ctx: Context, batchId: string): Promise<string> {
    const iterator = await ctx.stub.getStateByPartialCompositeKey(READING_INDEX, [batchId]);
    const readings: StoredReading[] = [];

    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }
        readings.push(JSON.parse(next.value.value.toString()) as StoredReading);
      }
    } finally {
      await iterator.close();
    }

    readings.sort((a, b) => a.observedAt - b.observedAt);
    return JSON.stringify(readings);
  }
}
