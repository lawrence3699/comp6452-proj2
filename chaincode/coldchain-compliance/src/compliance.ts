import { Context, Contract } from 'fabric-contract-api';
import { assertOracle } from './oracleIdentity';
import { cascadeRecall } from './recall';
import { invokeRegistry, REGISTRY_CHAINCODE } from './registry';
import { isBreach, rangeFor, VIOLATIONS_BEFORE_FLAG } from './thresholds';

export { REGISTRY_CHAINCODE };

export const READING_INDEX = 'temperature~batchId~observedAt';
export const VIOLATION_STATE = 'temperatureViolation~batchId';

const REGULATOR_ROLE = 'regulator';

interface RegistryBatch {
  readonly batchId: string;
  readonly foodType: string;
}

export interface TemperatureReading {
  readonly batchId: string;
  readonly tempC: number;
  readonly observedAt: number;
  readonly rawDataHash: string;
  readonly breach: boolean;
}

export interface ViolationState {
  readonly consecutiveBreaches: number;
  readonly lastObservedAt: number;
}

const assertRequired = (value: string, field: string): void => {
  if (value.trim().length === 0) {
    throw new Error(`SubmitTemperatureReading: ${field} is required`);
  }
};

const parseFiniteNumber = (
  value: string,
  field: string,
): number => {
  if (value.trim().length === 0) {
    throw new Error(
      `SubmitTemperatureReading: ${field} is required`,
    );
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(
      `SubmitTemperatureReading: ${field} must be a finite number`,
    );
  }

  return parsed;
};

const assertRegulator = (ctx: Context): void => {
  const role =
    ctx.clientIdentity.getAttributeValue('role');

  if (role !== REGULATOR_ROLE) {
    throw new Error(
      "access denied: caller must have role 'regulator'",
    );
  }
};

const parseBatch = (
  payload: Buffer,
  batchId: string,
): RegistryBatch => {
  let parsed: Partial<RegistryBatch>;

  try {
    parsed = JSON.parse(
      payload.toString('utf8'),
    ) as Partial<RegistryBatch>;
  } catch {
    throw new Error(
      `batch-registry GetBatch returned invalid JSON for batch ${batchId}`,
    );
  }

  if (
    parsed.batchId !== batchId ||
    typeof parsed.foodType !== 'string' ||
    !parsed.foodType
  ) {
    throw new Error(
      `batch-registry GetBatch returned invalid data for batch ${batchId}`,
    );
  }

  return parsed as RegistryBatch;
};

const readViolationState = async (
  ctx: Context,
  key: string,
): Promise<ViolationState | null> => {
  const raw = await ctx.stub.getState(key);

  if (!raw || raw.length === 0) {
    return null;
  }

  const parsed = JSON.parse(
    Buffer.from(raw).toString('utf8'),
  ) as Partial<ViolationState>;

  if (
    !Number.isInteger(parsed.consecutiveBreaches) ||
    !Number.isFinite(parsed.lastObservedAt)
  ) {
    throw new Error(
      'stored temperature violation state is invalid',
    );
  }

  return parsed as ViolationState;
};

/**
 * FR3 problem batch marking, driven by oracle
 * temperature readings.
 *
 * Owner: Person 2.
 */
export class ComplianceContract extends Contract {
  public async SubmitTemperatureReading(
    ctx: Context,
    batchId: string,
    tempCText: string,
    observedAtText: string,
    rawDataHash: string,
  ): Promise<void> {
    assertOracle(ctx);

    assertRequired(batchId, 'batchId');
    assertRequired(rawDataHash, 'rawDataHash');

    const tempC = parseFiniteNumber(
      tempCText,
      'tempC',
    );

    const observedAt = parseFiniteNumber(
      observedAtText,
      'observedAt',
    );

    if (
      !Number.isInteger(observedAt) ||
      observedAt <= 0
    ) {
      throw new Error(
        'SubmitTemperatureReading: observedAt must be a positive unix timestamp in seconds',
      );
    }

    /*
     * Obtain the batch food type from the batch-registry
     * chaincode.
     */
    const batchPayload = await invokeRegistry(
      ctx,
      'GetBatch',
      batchId,
    );

    const batch = parseBatch(
      batchPayload,
      batchId,
    );

    /*
     * Each reading is stored using batchId and observedAt.
     */
    const readingKey =
      ctx.stub.createCompositeKey(
        READING_INDEX,
        [
          batchId,
          observedAt.toString(),
        ],
      );

    const existing =
      await ctx.stub.getState(readingKey);

    if (existing && existing.length > 0) {
      throw new Error(
        `SubmitTemperatureReading: a reading for batch ${batchId} at ${observedAt} already exists`,
      );
    }

    /*
     * Read the current consecutive violation count.
     */
    const stateKey =
      ctx.stub.createCompositeKey(
        VIOLATION_STATE,
        [batchId],
      );

    const previous =
      await readViolationState(
        ctx,
        stateKey,
      );

    /*
     * Temperature readings must arrive chronologically.
     */
    if (
      previous &&
      observedAt <= previous.lastObservedAt
    ) {
      throw new Error(
        `SubmitTemperatureReading: observedAt must be later than ${previous.lastObservedAt}`,
      );
    }

    /*
     * Check whether this reading is outside the valid
     * temperature range.
     */
    const breach = isBreach(
      batch.foodType,
      tempC,
    );

    /*
     * An in-range reading resets the consecutive
     * violation counter.
     */
    const consecutiveBreaches = breach
      ? (
          previous?.consecutiveBreaches ?? 0
        ) + 1
      : 0;

    const reading: TemperatureReading = {
      batchId,
      tempC,
      observedAt,
      rawDataHash,
      breach,
    };

    const nextState: ViolationState = {
      consecutiveBreaches,
      lastObservedAt: observedAt,
    };

    /*
     * Persist the individual reading and the latest
     * violation state.
     */
    await ctx.stub.putState(
      readingKey,
      Buffer.from(
        JSON.stringify(reading),
      ),
    );

    await ctx.stub.putState(
      stateKey,
      Buffer.from(
        JSON.stringify(nextState),
      ),
    );

    /*
     * Flag the batch when three consecutive violations
     * have occurred.
     */
    if (
      consecutiveBreaches ===
      VIOLATIONS_BEFORE_FLAG
    ) {
      const range =
        rangeFor(batch.foodType);

      const reason =
        `${VIOLATIONS_BEFORE_FLAG} consecutive temperature violations for ${batch.foodType}; ` +
        `expected ${range.minC}C to ${range.maxC}C, latest reading ${tempC}C`;

      await invokeRegistry(
        ctx,
        'FlagBatch',
        batchId,
        reason,
        rawDataHash,
      );

      // Emit BatchFlagged from this (top-level) chaincode as well. The event
      // that FlagBatch sets inside the nested invokeChaincode above is NOT
      // delivered to chaincode-event listeners — Fabric only surfaces the
      // top-level chaincode's event — so the off-chain indexer would otherwise
      // never see the automated flag. Payload mirrors batch-registry's.
      ctx.stub.setEvent(
        'BatchFlagged',
        Buffer.from(
          JSON.stringify({
            batchId,
            reason,
            evidenceHash: rawDataHash,
            flaggedBy: 'oracle',
            timestamp: observedAt,
          }),
        ),
      );
    }
  }

  /**
   * Allows a regulator to flag a batch manually.
   */
  public async FlagByRegulator(
    ctx: Context,
    batchId: string,
    reason: string,
    evidenceHash: string,
  ): Promise<void> {
    assertRegulator(ctx);

    if (!batchId.trim()) {
      throw new Error(
        'FlagByRegulator: batchId is required',
      );
    }

    if (!reason.trim()) {
      throw new Error(
        'FlagByRegulator: reason is required',
      );
    }

    if (!evidenceHash.trim()) {
      throw new Error(
        'FlagByRegulator: evidenceHash is required',
      );
    }

    await invokeRegistry(
      ctx,
      'FlagBatch',
      batchId,
      reason,
      evidenceHash,
    );
  }

  /**
   * Recalls a batch and all batches derived from it.
   */
  public async RecallBatch(
    ctx: Context,
    batchId: string,
  ): Promise<void> {
    assertRegulator(ctx);

    if (!batchId.trim()) {
      throw new Error(
        'RecallBatch: batchId is required',
      );
    }

    await cascadeRecall(
      ctx,
      batchId,
    );
  }
}
