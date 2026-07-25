import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Context } from 'fabric-contract-api';
import { isBreach, rangeFor, DEFAULT_RANGE } from '../src/thresholds';
import { ComplianceContract } from '../src/compliance';

chai.use(chaiAsPromised);
const { expect } = chai;

describe('temperature thresholds', () => {
  it('treats minus twenty as normal for frozen goods', () => {
    expect(isBreach('frozen', -20)).to.equal(false);
  });

  it('treats minus twenty as a breach for chilled goods', () => {
    expect(isBreach('chilled', -20)).to.equal(true);
  });

  it('falls back to the ambient range for an unknown food type', () => {
    expect(rangeFor('something-new')).to.deep.equal(DEFAULT_RANGE);
  });
});

interface InvokeCall {
  chaincode: string;
  args: string[];
  channel: string;
}

/**
 * Stubbed context that also records cross-chaincode calls, which is how the
 * flagging and cascade tests observe behaviour without a live network.
 */
const makeContext = (
  batches: Record<string, { foodType: string; status: string }>,
  /** Parent -> children, standing in for batch-registry's derivedFrom index. */
  derived: Record<string, string[]> = {},
) => {
  const state = new Map<string, Buffer>();
  const invokes: InvokeCall[] = [];
  const events: { name: string; payload: unknown }[] = [];
  let attrs: Record<string, string> = { oracle: 'true' };

  const compositeKey = (objectType: string, attributes: string[]) =>
    ` ${objectType} ${attributes.join(' ')} `;

  const stub = {
    getState: async (k: string) => state.get(k) ?? Buffer.alloc(0),
    putState: async (k: string, v: Buffer) => {
      state.set(k, v);
    },
    createCompositeKey: compositeKey,
    splitCompositeKey: (key: string) => {
      const parts = key.split(' ').filter((p) => p.length > 0);
      return { objectType: parts[0], attributes: parts.slice(1) };
    },
    // Only ever sees `state`, which models THIS chaincode's namespace. Data
    // owned by batch-registry is reachable solely through invokeChaincode
    // below, never from here — an earlier stub that ignored namespace
    // isolation let a broken cascade pass its unit test while silently doing
    // nothing on a real peer.
    getStateByPartialCompositeKey: async (objectType: string, attributes: string[]) => {
      const prefix = ` ${objectType} ${attributes.join(' ')} `;
      const matches: { key: string; value: Buffer }[] = [];
      state.forEach((v, k) => {
        if (k.startsWith(prefix)) {
          matches.push({ key: k, value: v });
        }
      });
      let i = 0;
      return {
        next: async () =>
          i < matches.length
            ? { done: false, value: matches[i++] }
            : { done: true, value: undefined },
        close: async () => undefined,
      } as never;
    },
    setEvent: (name: string, payload: Buffer) => {
      events.push({ name, payload: JSON.parse(payload.toString()) });
    },
    invokeChaincode: async (chaincode: string, args: string[], channel: string) => {
      invokes.push({ chaincode, args, channel });
      const fn = args[0];

      if (fn === 'BatchRegistryContract:GetBatch') {
        const b = batches[args[1]];
        if (!b) {
          return { status: 500, message: 'not found', payload: Buffer.alloc(0) };
        }
        return {
          status: 200,
          message: '',
          payload: Buffer.from(JSON.stringify({ batchId: args[1], ...b })),
        };
      }

      // Served by batch-registry because the index lives in its namespace.
      if (fn === 'BatchQueryContract:GetDerivedBatches') {
        return {
          status: 200,
          message: '',
          payload: Buffer.from(JSON.stringify(derived[args[1]] ?? [])),
        };
      }

      if (fn === 'BatchRegistryContract:FlagBatch') {
        batches[args[1]].status = 'FLAGGED';
      }
      if (fn === 'BatchRegistryContract:RecallBatch') {
        batches[args[1]].status = 'RECALLED';
      }
      return { status: 200, message: '', payload: Buffer.alloc(0) };
    },
  };

  const ctx = {
    stub,
    clientIdentity: { getAttributeValue: (a: string) => (a in attrs ? attrs[a] : null) },
  } as unknown as Context;

  return {
    ctx,
    state,
    batches,
    invokes,
    events,
    compositeKey,
    setCaller: (a: Record<string, string>) => {
      attrs = a;
    },
  };
};

describe('ComplianceContract', () => {
  let cc: ComplianceContract;

  beforeEach(() => {
    cc = new ComplianceContract();
  });

  it('does not flag a batch while readings stay inside the range', async () => {
    const t = makeContext({ B1: { foodType: 'chilled', status: 'IN_TRANSIT' } });

    // Chilled range is 0..4; all of these sit comfortably inside it.
    await cc.SubmitTemperatureReading(t.ctx, 'B1', '2', '1000', 'h1');
    await cc.SubmitTemperatureReading(t.ctx, 'B1', '3', '1001', 'h2');
    await cc.SubmitTemperatureReading(t.ctx, 'B1', '1', '1002', 'h3');
    await cc.SubmitTemperatureReading(t.ctx, 'B1', '4', '1003', 'h4');

    const flags = t.invokes.filter((i) => i.args[0] === 'BatchRegistryContract:FlagBatch');
    expect(flags).to.have.length(0);
    expect(await cc.GetBreachCount(t.ctx, 'B1')).to.equal(0);
  });

  it('flags the batch through invokeChaincode once the breach count is reached', async () => {
    const t = makeContext({ B2: { foodType: 'chilled', status: 'IN_TRANSIT' } });

    await cc.SubmitTemperatureReading(t.ctx, 'B2', '9', '1000', 'h1');
    await cc.SubmitTemperatureReading(t.ctx, 'B2', '9.5', '1001', 'h2');
    expect(
      t.invokes.filter((i) => i.args[0] === 'BatchRegistryContract:FlagBatch'),
    ).to.have.length(0);

    // Third consecutive breach crosses VIOLATIONS_BEFORE_FLAG.
    await cc.SubmitTemperatureReading(t.ctx, 'B2', '10', '1002', 'evidence-hash');

    const flags = t.invokes.filter((i) => i.args[0] === 'BatchRegistryContract:FlagBatch');
    expect(flags).to.have.length(1);
    expect(flags[0].chaincode).to.equal('batch-registry');
    expect(flags[0].channel).to.equal('mychannel');
    expect(flags[0].args[1]).to.equal('B2');
    expect(flags[0].args[2]).to.match(/cold chain breach/);
    expect(flags[0].args[3]).to.equal('evidence-hash');
  });

  it('resets the consecutive counter when a reading returns to range', async () => {
    const t = makeContext({ B3: { foodType: 'chilled', status: 'IN_TRANSIT' } });

    await cc.SubmitTemperatureReading(t.ctx, 'B3', '9', '1000', 'h1');
    await cc.SubmitTemperatureReading(t.ctx, 'B3', '9', '1001', 'h2');
    // Back inside range: the excursion is over.
    await cc.SubmitTemperatureReading(t.ctx, 'B3', '2', '1002', 'h3');
    expect(await cc.GetBreachCount(t.ctx, 'B3')).to.equal(0);

    // Two more breaches must not be enough, because the counter restarted.
    await cc.SubmitTemperatureReading(t.ctx, 'B3', '9', '1003', 'h4');
    await cc.SubmitTemperatureReading(t.ctx, 'B3', '9', '1004', 'h5');

    expect(
      t.invokes.filter((i) => i.args[0] === 'BatchRegistryContract:FlagBatch'),
    ).to.have.length(0);
  });

  it('rejects a reading submitted by a non-oracle identity', async () => {
    const t = makeContext({ B4: { foodType: 'chilled', status: 'IN_TRANSIT' } });
    t.setCaller({ role: 'transporter' });

    await expect(cc.SubmitTemperatureReading(t.ctx, 'B4', '9', '1000', 'h1')).to.be.rejectedWith(
      /only an identity enrolled with the oracle attribute/,
    );
  });

  it('rejects a non-numeric temperature', async () => {
    const t = makeContext({ B5: { foodType: 'chilled', status: 'IN_TRANSIT' } });
    await expect(
      cc.SubmitTemperatureReading(t.ctx, 'B5', 'very cold', '1000', 'h1'),
    ).to.be.rejectedWith(/is not a number/);
  });

  it('cascades a recall to downstream batches', async () => {
    // The derivation index belongs to batch-registry's namespace, so it is
    // supplied here as registry data reachable only through invokeChaincode —
    // not written into this chaincode's own state.
    const t = makeContext(
      {
        ROOT: { foodType: 'chilled', status: 'FLAGGED' },
        CHILD1: { foodType: 'chilled', status: 'AT_WAREHOUSE' },
        CHILD2: { foodType: 'chilled', status: 'AT_WAREHOUSE' },
        GRANDCHILD: { foodType: 'chilled', status: 'AT_WAREHOUSE' },
      },
      { ROOT: ['CHILD1', 'CHILD2'], CHILD1: ['GRANDCHILD'] },
    );

    t.setCaller({ role: 'regulator' });
    const recalled = JSON.parse(await cc.RecallBatch(t.ctx, 'ROOT')) as string[];

    // The whole derivation graph must be recalled, not just the first level.
    expect(recalled).to.have.members(['ROOT', 'CHILD1', 'CHILD2', 'GRANDCHILD']);
    expect(recalled[0]).to.equal('ROOT');
    expect(t.batches.GRANDCHILD.status).to.equal('RECALLED');

    const recallCalls = t.invokes.filter(
      (i) => i.args[0] === 'BatchRegistryContract:RecallBatch',
    );
    expect(recallCalls).to.have.length(4);
  });

  it('reads the derivation index through batch-registry, not its own state', async () => {
    // Regression guard for a real bug: cascadeRecall used to scan
    // derivedFrom~batchId with its own getStateByPartialCompositeKey, which
    // searches this chaincode's namespace and silently found nothing, so a
    // recall only ever affected the batch it was called on.
    const t = makeContext(
      {
        ROOT: { foodType: 'chilled', status: 'FLAGGED' },
        CHILD: { foodType: 'chilled', status: 'FLAGGED' },
      },
      { ROOT: ['CHILD'] },
    );

    t.setCaller({ role: 'regulator' });
    await cc.RecallBatch(t.ctx, 'ROOT');

    const lookups = t.invokes.filter(
      (i) => i.args[0] === 'BatchQueryContract:GetDerivedBatches',
    );
    expect(lookups.length).to.be.greaterThan(0);
    expect(lookups[0].chaincode).to.equal('batch-registry');
    expect(t.batches.CHILD.status).to.equal('RECALLED');
  });

  it('does not loop forever when the derivation graph contains a cycle', async () => {
    const t = makeContext(
      {
        A: { foodType: 'chilled', status: 'FLAGGED' },
        B: { foodType: 'chilled', status: 'FLAGGED' },
      },
      { A: ['B'], B: ['A'] },
    );

    t.setCaller({ role: 'regulator' });
    const recalled = JSON.parse(await cc.RecallBatch(t.ctx, 'A')) as string[];

    expect(recalled).to.have.members(['A', 'B']);
  });

  it('rejects a recall from a non-regulator', async () => {
    const t = makeContext({ B6: { foodType: 'chilled', status: 'FLAGGED' } });
    t.setCaller({ oracle: 'true' });

    await expect(cc.RecallBatch(t.ctx, 'B6')).to.be.rejectedWith(/is not a regulator/);
  });
});
