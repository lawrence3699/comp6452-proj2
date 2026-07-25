import { Context, Contract } from 'fabric-contract-api';
import { Batch, BatchStatus, withHolder, withStatus } from './batch';
import { Role, assertRole, callerMsp, hasRole } from './access';
import { assertTransition } from './stateMachine';
import {
  getPrivateDetails,
  getPrivateDetailsHash,
  putPrivateDetails,
  readTransientDetails,
} from './privateData';

/** Composite key indexing batches by their current holder, for queries.ts. */
export const HOLDER_INDEX = 'holder~batchId';

/** Composite key linking a batch to the batch it was derived from. */
export const DERIVED_INDEX = 'derivedFrom~batchId';

/** Payload accepted by RegisterBatch, before validation. */
interface RegisterPayload {
  batchId?: string;
  foodType?: string;
  producedAt?: number;
  shelfLifeDays?: number;
  origin?: string;
  quantity?: number;
  /** Optional parent batch, so recalls can cascade downstream. */
  derivedFrom?: string;
  reportHash?: string;
}

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

const readBatch = async (ctx: Context, batchId: string): Promise<Batch> => {
  const raw = await ctx.stub.getState(batchId);
  if (!raw || raw.length === 0) {
    throw new Error(`batch ${batchId} does not exist`);
  }
  return JSON.parse(raw.toString()) as Batch;
};

const writeBatch = async (ctx: Context, batch: Batch): Promise<void> => {
  await ctx.stub.putState(batch.batchId, Buffer.from(JSON.stringify(batch)));
};

const holderKey = (ctx: Context, holder: string, batchId: string): string =>
  ctx.stub.createCompositeKey(HOLDER_INDEX, [holder, batchId]);

/**
 * FR1 batch registration and the custody write path.
 * Owner: person 1. The read-only query path lives in queries.ts (person 4).
 */
export class BatchRegistryContract extends Contract {
  /**
   * Register a new batch. Producers only.
   *
   * Sensitive commercial fields are not part of batchJson — they travel in the
   * transient map and land in the private data collection.
   */
  public async RegisterBatch(ctx: Context, batchJson: string): Promise<void> {
    assertRole(ctx, Role.Producer);

    let payload: RegisterPayload;
    try {
      payload = JSON.parse(batchJson) as RegisterPayload;
    } catch {
      throw new Error('RegisterBatch: batchJson is not valid JSON');
    }

    const batchId = payload.batchId;
    if (!batchId) {
      throw new Error('RegisterBatch: batchId is required');
    }

    const existing = await ctx.stub.getState(batchId);
    if (existing && existing.length > 0) {
      throw new Error(`RegisterBatch: batch ${batchId} already exists`);
    }

    if (!payload.foodType) {
      throw new Error('RegisterBatch: foodType is required');
    }

    const shelfLifeDays = Number(payload.shelfLifeDays);
    if (!Number.isFinite(shelfLifeDays) || shelfLifeDays <= 0) {
      throw new Error('RegisterBatch: shelfLifeDays must be greater than zero');
    }

    const quantity = Number(payload.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error('RegisterBatch: quantity must be greater than zero');
    }

    const producedAt = Number(payload.producedAt);
    if (!Number.isFinite(producedAt)) {
      throw new Error('RegisterBatch: producedAt must be a unix timestamp in seconds');
    }
    if (producedAt > txTimeSeconds(ctx)) {
      throw new Error('RegisterBatch: producedAt is in the future');
    }

    const holder = callerMsp(ctx);
    const batch: Batch = {
      batchId,
      foodType: payload.foodType,
      producedAt,
      shelfLifeDays,
      origin: payload.origin ?? '',
      quantity,
      status: BatchStatus.Created,
      currentHolder: holder,
      reportHash: payload.reportHash ?? '',
    };

    await writeBatch(ctx, batch);

    // Index by holder so GetBatchesByHolder can range-scan without a full scan.
    // The value is a sentinel: the batch itself stays under its plain key.
    await ctx.stub.putState(holderKey(ctx, holder, batchId), Buffer.from('\u0000'));

    // Link to the parent batch so coldchain-compliance can cascade a recall.
    if (payload.derivedFrom) {
      await ctx.stub.putState(
        ctx.stub.createCompositeKey(DERIVED_INDEX, [payload.derivedFrom, batchId]),
        Buffer.from('\u0000'),
      );
    }

    const details = readTransientDetails(ctx, batchId);
    if (details) {
      await putPrivateDetails(ctx, details);
    }

    ctx.stub.setEvent(
      'BatchRegistered',
      Buffer.from(
        JSON.stringify({ batchId, producer: holder, timestamp: txTimeSeconds(ctx) }),
      ),
    );
  }

  /**
   * Hand the batch to another organisation.
   *
   * Only the current holder may transfer, and the resulting status must be a
   * legal move in the state machine — this is what stops a delivered batch from
   * re-entering transit.
   */
  public async TransferCustody(ctx: Context, batchId: string, toMsp: string): Promise<void> {
    if (!toMsp) {
      throw new Error('TransferCustody: toMsp is required');
    }

    const batch = await readBatch(ctx, batchId);
    const caller = callerMsp(ctx);

    if (batch.currentHolder !== caller) {
      throw new Error(
        `TransferCustody: caller ${caller} is not the current holder ${batch.currentHolder}`,
      );
    }

    // Receiving into a warehouse is the one move that parks the batch rather
    // than keeping it moving; everything else is another leg of transit.
    const next =
      batch.status === BatchStatus.InTransit ? BatchStatus.AtWarehouse : BatchStatus.InTransit;
    assertTransition(batch.status, next);

    const moved = withStatus(withHolder(batch, toMsp), next);
    await writeBatch(ctx, moved);

    // Keep the holder index in step, or the old holder keeps showing the batch.
    ctx.stub.deleteState(holderKey(ctx, caller, batchId));
    await ctx.stub.putState(holderKey(ctx, toMsp, batchId), Buffer.from('\u0000'));

    ctx.stub.setEvent(
      'CustodyTransferred',
      Buffer.from(
        JSON.stringify({ batchId, from: caller, to: toMsp, timestamp: txTimeSeconds(ctx) }),
      ),
    );
  }

  /**
   * Mark a batch as a problem.
   *
   * Two callers are legitimate: a regulator acting directly, and the
   * coldchain-compliance chaincode reacting to the oracle.
   *
   * The subtlety is that invokeChaincode does NOT re-sign the transaction — the
   * client identity stays that of the original submitter, which for the oracle
   * path is the oracle's certificate, not a regulator's. A plain
   * assertRole(Regulator) would therefore reject the automated path that FR3
   * depends on. We accept either a regulator certificate or an oracle
   * certificate, and record which one it was in the event so the audit trail
   * distinguishes a human decision from an automated one.
   */
  public async FlagBatch(
    ctx: Context,
    batchId: string,
    reason: string,
    evidenceHash: string,
  ): Promise<void> {
    if (!reason) {
      throw new Error('FlagBatch: reason is required');
    }

    const isRegulator = hasRole(ctx, Role.Regulator);
    const isOracle = ctx.clientIdentity.getAttributeValue('oracle') === 'true';

    if (!isRegulator && !isOracle) {
      throw new Error(
        'FlagBatch: caller must be a regulator, or the oracle acting through ' +
          'coldchain-compliance',
      );
    }

    const batch = await readBatch(ctx, batchId);

    // Flagging an already-flagged or recalled batch is a no-op rather than an
    // error: the oracle may legitimately re-report the same breach.
    if (batch.status === BatchStatus.Flagged || batch.status === BatchStatus.Recalled) {
      return;
    }

    assertTransition(batch.status, BatchStatus.Flagged);
    await writeBatch(ctx, withStatus(batch, BatchStatus.Flagged));

    ctx.stub.setEvent(
      'BatchFlagged',
      Buffer.from(
        JSON.stringify({
          batchId,
          reason,
          evidenceHash,
          flaggedBy: isRegulator ? 'regulator' : 'oracle',
          timestamp: txTimeSeconds(ctx),
        }),
      ),
    );
  }

  /**
   * Move a flagged batch to recalled.
   *
   * Kept here rather than in coldchain-compliance because this chaincode owns
   * the batch state; compliance drives the cascade and calls in for each batch.
   */
  public async RecallBatch(ctx: Context, batchId: string): Promise<void> {
    const isRegulator = hasRole(ctx, Role.Regulator);
    const isOracle = ctx.clientIdentity.getAttributeValue('oracle') === 'true';

    if (!isRegulator && !isOracle) {
      throw new Error('RecallBatch: caller must be a regulator or the oracle');
    }

    const batch = await readBatch(ctx, batchId);
    if (batch.status === BatchStatus.Recalled) {
      return;
    }

    assertTransition(batch.status, BatchStatus.Recalled);
    await writeBatch(ctx, withStatus(batch, BatchStatus.Recalled));

    ctx.stub.setEvent(
      'BatchRecalled',
      Buffer.from(JSON.stringify({ batchId, timestamp: txTimeSeconds(ctx) })),
    );
  }

  /** Read a single batch. Used by clients and by coldchain-compliance. */
  public async GetBatch(ctx: Context, batchId: string): Promise<string> {
    const batch = await readBatch(ctx, batchId);
    return JSON.stringify(batch);
  }

  /** True when the batch exists — cheaper than GetBatch for existence checks. */
  public async BatchExists(ctx: Context, batchId: string): Promise<boolean> {
    const raw = await ctx.stub.getState(batchId);
    return raw !== undefined && raw !== null && raw.length > 0;
  }

  /**
   * Read the commercially sensitive fields.
   *
   * Only succeeds on a peer whose organisation is in the collection policy;
   * everyone else gets an error rather than the data, which is the whole point
   * of keeping these fields off the public ledger.
   */
  public async GetPrivateDetails(ctx: Context, batchId: string): Promise<string> {
    const details = await getPrivateDetails(ctx, batchId);
    return JSON.stringify(details);
  }

  /**
   * Read the private-data hash from the public ledger.
   *
   * Readable by any peer, including organisations outside the collection, so an
   * auditor can prove the private payload has not changed since commit without
   * ever seeing its contents.
   */
  public async GetPrivateDetailsHash(ctx: Context, batchId: string): Promise<string> {
    return getPrivateDetailsHash(ctx, batchId);
  }
}
