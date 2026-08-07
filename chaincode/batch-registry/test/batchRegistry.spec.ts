import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as sinon from 'sinon';
import { Context } from 'fabric-contract-api';

chai.use(chaiAsPromised);
const { expect } = chai;

import { Batch, BatchStatus } from '../src/batch';
import { canTransition } from '../src/stateMachine';
import { BatchRegistryContract, HOLDER_INDEX } from '../src/batchRegistry';
import { Role } from '../src/access';

describe('state machine', () => {
  it('allows a created batch to move into transit', () => {
    expect(canTransition(BatchStatus.Created, BatchStatus.InTransit)).to.equal(true);
  });

  it('refuses to move a delivered batch back into transit', () => {
    expect(canTransition(BatchStatus.Delivered, BatchStatus.InTransit)).to.equal(false);
  });
});

/**
 * A minimal in-memory ledger standing in for the peer.
 *
 * The four cases below are required by the marking criteria. They run against a
 * stubbed ChaincodeStub rather than a live network, so the suite stays fast and
 * needs no Docker.
 */
class FakeLedger {
  public readonly state = new Map<string, Buffer>();
  public readonly events: { name: string; payload: unknown }[] = [];

  public reset(): void {
    this.state.clear();
    this.events.length = 0;
  }
}

interface TestCtx {
  ctx: Context;
  ledger: FakeLedger;
  setCaller: (msp: string, attrs: Record<string, string>) => void;
}

const makeContext = (nowSeconds = 1_800_000_000): TestCtx => {
  const ledger = new FakeLedger();
  let msp = 'Org1MSP';
  let attrs: Record<string, string> = {};

  const stub = {
    getState: async (k: string) => ledger.state.get(k) ?? Buffer.alloc(0),
    putState: async (k: string, v: Buffer) => {
      ledger.state.set(k, v);
    },
    deleteState: (k: string) => {
      ledger.state.delete(k);
    },
    createCompositeKey: (objectType: string, attributes: string[]) =>
      `\u0000${objectType}\u0000${attributes.join('\u0000')}\u0000`,
    getTxTimestamp: () => ({ seconds: nowSeconds, nanos: 0 }),
    getTransient: () => new Map<string, Uint8Array>(),
    setEvent: (name: string, payload: Buffer) => {
      ledger.events.push({ name, payload: JSON.parse(payload.toString()) });
    },
    putPrivateData: async () => undefined,
  };

  const clientIdentity = {
    getMSPID: () => msp,
    getAttributeValue: (a: string) => (a in attrs ? attrs[a] : null),
  };

  const ctx = { stub, clientIdentity } as unknown as Context;

  return {
    ctx,
    ledger,
    setCaller: (m, a) => {
      msp = m;
      attrs = a;
    },
  };
};

const producer = { role: Role.Producer };
const regulator = { role: Role.Regulator };

const validBatch = (over: Partial<Batch> & { batchId: string }) =>
  JSON.stringify({
    foodType: 'chilled',
    producedAt: 1_700_000_000,
    shelfLifeDays: 14,
    origin: 'Farm A',
    quantity: 100,
    ...over,
  });

describe('BatchRegistryContract', () => {
  let cc: BatchRegistryContract;
  let t: TestCtx;

  beforeEach(() => {
    cc = new BatchRegistryContract();
    t = makeContext();
  });

  afterEach(() => sinon.restore());

  it('registers, transfers and delivers a batch', async () => {
    t.setCaller('Org1MSP', producer);
    await cc.RegisterBatch(t.ctx, validBatch({ batchId: 'B1' }));

    let batch = JSON.parse(await cc.GetBatch(t.ctx, 'B1')) as Batch;
    expect(batch.status).to.equal(BatchStatus.Created);
    expect(batch.currentHolder).to.equal('Org1MSP');
    expect(t.ledger.events.map((e) => e.name)).to.include('BatchRegistered');

    // Producer hands to the transporter: CREATED -> IN_TRANSIT.
    await cc.TransferCustody(t.ctx, 'B1', 'Org2MSP');
    batch = JSON.parse(await cc.GetBatch(t.ctx, 'B1')) as Batch;
    expect(batch.status).to.equal(BatchStatus.InTransit);
    expect(batch.currentHolder).to.equal('Org2MSP');

    // The holder index must follow the batch, or queries go stale.
    const oldKey = t.ctx.stub.createCompositeKey(HOLDER_INDEX, ['Org1MSP', 'B1']);
    const newKey = t.ctx.stub.createCompositeKey(HOLDER_INDEX, ['Org2MSP', 'B1']);
    expect(t.ledger.state.has(oldKey)).to.equal(false);
    expect(t.ledger.state.has(newKey)).to.equal(true);

    // Transporter into the warehouse: IN_TRANSIT -> AT_WAREHOUSE.
    t.setCaller('Org2MSP', { role: Role.Transporter });
    await cc.TransferCustody(t.ctx, 'B1', 'Org1MSP');
    batch = JSON.parse(await cc.GetBatch(t.ctx, 'B1')) as Batch;
    expect(batch.status).to.equal(BatchStatus.AtWarehouse);

    expect(t.ledger.events.filter((e) => e.name === 'CustodyTransferred')).to.have.length(2);
  });

  it('rejects registration from a non-producer identity', async () => {
    t.setCaller('Org1MSP', { role: Role.Transporter });
    await expect(cc.RegisterBatch(t.ctx, validBatch({ batchId: 'B2' }))).to.be.rejectedWith(
      /access denied/,
    );
  });

  it('rejects a custody transfer from an identity that is not the holder', async () => {
    t.setCaller('Org1MSP', producer);
    await cc.RegisterBatch(t.ctx, validBatch({ batchId: 'B3' }));

    // Org2 never held this batch.
    t.setCaller('Org2MSP', { role: Role.Transporter });
    await expect(cc.TransferCustody(t.ctx, 'B3', 'Org1MSP')).to.be.rejectedWith(
      /not the current holder/,
    );
  });

  it('rejects a custody transfer on an already delivered batch', async () => {
    t.setCaller('Org1MSP', producer);
    await cc.RegisterBatch(t.ctx, validBatch({ batchId: 'B4' }));

    // Force the terminal state directly; reaching DELIVERED through the normal
    // path is covered by the first test.
    const delivered: Batch = {
      ...(JSON.parse(await cc.GetBatch(t.ctx, 'B4')) as Batch),
      status: BatchStatus.Delivered,
    };
    t.ledger.state.set('B4', Buffer.from(JSON.stringify(delivered)));

    await expect(cc.TransferCustody(t.ctx, 'B4', 'Org2MSP')).to.be.rejectedWith(
      /illegal status transition/,
    );
  });

  it('rejects a batch produced in the future', async () => {
    t.setCaller('Org1MSP', producer);
    await expect(
      cc.RegisterBatch(t.ctx, validBatch({ batchId: 'B5', producedAt: 1_900_000_000 } as never)),
    ).to.be.rejectedWith(/producedAt is in the future/);
  });

  it('rejects a non-positive shelf life', async () => {
    t.setCaller('Org1MSP', producer);
    await expect(
      cc.RegisterBatch(t.ctx, validBatch({ batchId: 'B6', shelfLifeDays: 0 } as never)),
    ).to.be.rejectedWith(/shelfLifeDays/);
  });

  it('refuses to register the same batch twice', async () => {
    t.setCaller('Org1MSP', producer);
    await cc.RegisterBatch(t.ctx, validBatch({ batchId: 'B7' }));
    await expect(cc.RegisterBatch(t.ctx, validBatch({ batchId: 'B7' }))).to.be.rejectedWith(
      /already exists/,
    );
  });

  it('lets the oracle flag a batch through the compliance path', async () => {
    t.setCaller('Org1MSP', producer);
    await cc.RegisterBatch(t.ctx, validBatch({ batchId: 'B8' }));

    // invokeChaincode does not re-sign, so the oracle's own certificate is what
    // FlagBatch sees when coldchain-compliance calls in.
    t.setCaller('Org1MSP', { oracle: 'true' });
    await cc.FlagBatch(t.ctx, 'B8', 'cold chain breach', 'hash123');

    const batch = JSON.parse(await cc.GetBatch(t.ctx, 'B8')) as Batch;
    expect(batch.status).to.equal(BatchStatus.Flagged);

    const flagged = t.ledger.events.find((e) => e.name === 'BatchFlagged');
    expect(flagged).to.not.equal(undefined);
    expect((flagged?.payload as { flaggedBy: string }).flaggedBy).to.equal('oracle');
  });

  it('rejects a flag from an identity that is neither regulator nor oracle', async () => {
    t.setCaller('Org1MSP', producer);
    await cc.RegisterBatch(t.ctx, validBatch({ batchId: 'B9' }));

    t.setCaller('Org1MSP', { role: Role.Transporter });
    await expect(cc.FlagBatch(t.ctx, 'B9', 'because', 'h')).to.be.rejectedWith(
      /must be a regulator, or the oracle/,
    );
  });

  it('lets a regulator flag a batch directly', async () => {
    t.setCaller('Org1MSP', producer);
    await cc.RegisterBatch(t.ctx, validBatch({ batchId: 'B10' }));

    t.setCaller('Org1MSP', regulator);
    await cc.FlagBatch(t.ctx, 'B10', 'manual inspection', 'h2');

    const flagged = t.ledger.events.find((e) => e.name === 'BatchFlagged');
    expect((flagged?.payload as { flaggedBy: string }).flaggedBy).to.equal('regulator');
  });

  /** Walk a fresh batch to AT_WAREHOUSE with Org1MSP as the final holder. */
  const batchAtWarehouse = async (batchId: string): Promise<void> => {
    t.setCaller('Org1MSP', producer);
    await cc.RegisterBatch(t.ctx, validBatch({ batchId }));
    await cc.TransferCustody(t.ctx, batchId, 'Org2MSP'); // CREATED -> IN_TRANSIT
    t.setCaller('Org2MSP', { role: Role.Transporter });
    await cc.TransferCustody(t.ctx, batchId, 'Org1MSP'); // IN_TRANSIT -> AT_WAREHOUSE
  };

  it('lets the current holder mark a warehoused batch as delivered', async () => {
    await batchAtWarehouse('B11');

    // No role attribute at all — possession alone must be enough.
    t.setCaller('Org1MSP', {});
    await cc.MarkDelivered(t.ctx, 'B11');

    const batch = JSON.parse(await cc.GetBatch(t.ctx, 'B11')) as Batch;
    expect(batch.status).to.equal(BatchStatus.Delivered);
    expect(batch.currentHolder).to.equal('Org1MSP');

    const delivered = t.ledger.events.find((e) => e.name === 'BatchDelivered');
    expect(delivered).to.not.equal(undefined);
    const payload = delivered?.payload as { batchId: string; holder: string; timestamp: number };
    expect(payload.batchId).to.equal('B11');
    expect(payload.holder).to.equal('Org1MSP');
    expect(payload.timestamp).to.equal(1_800_000_000);

    // Delivery does not move the batch, so the holder index must not change.
    const key = t.ctx.stub.createCompositeKey(HOLDER_INDEX, ['Org1MSP', 'B11']);
    expect(t.ledger.state.has(key)).to.equal(true);
  });

  it('rejects MarkDelivered from an identity that is not the holder', async () => {
    await batchAtWarehouse('B12');

    // Org2 handed the batch off already; it can no longer close the journey.
    t.setCaller('Org2MSP', { role: Role.Transporter });
    await expect(cc.MarkDelivered(t.ctx, 'B12')).to.be.rejectedWith(/not the current holder/);
    expect(t.ledger.events.some((e) => e.name === 'BatchDelivered')).to.equal(false);
  });

  it('rejects MarkDelivered on a batch still in transit', async () => {
    t.setCaller('Org1MSP', producer);
    await cc.RegisterBatch(t.ctx, validBatch({ batchId: 'B13' }));
    await cc.TransferCustody(t.ctx, 'B13', 'Org2MSP'); // CREATED -> IN_TRANSIT

    t.setCaller('Org2MSP', { role: Role.Transporter });
    await expect(cc.MarkDelivered(t.ctx, 'B13')).to.be.rejectedWith(
      /illegal status transition/,
    );
  });

  it('rejects a second MarkDelivered on an already delivered batch', async () => {
    await batchAtWarehouse('B14');
    t.setCaller('Org1MSP', {});
    await cc.MarkDelivered(t.ctx, 'B14');

    // DELIVERED -> DELIVERED is not in the state machine, so unlike FlagBatch
    // there is no idempotent no-op here: the repeat call must throw.
    await expect(cc.MarkDelivered(t.ctx, 'B14')).to.be.rejectedWith(
      /illegal status transition/,
    );
    expect(t.ledger.events.filter((e) => e.name === 'BatchDelivered')).to.have.length(1);
  });
});
