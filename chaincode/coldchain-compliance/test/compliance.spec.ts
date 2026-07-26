/// <reference types="mocha" />

import { expect } from 'chai';
import { Context } from 'fabric-contract-api';
import {
  ComplianceContract,
  READING_INDEX,
  TemperatureReading,
  VIOLATION_STATE,
  ViolationState,
} from '../src/compliance';
import { DERIVED_BATCH_QUERY } from '../src/recall';
import { DEFAULT_RANGE, isBreach, rangeFor } from '../src/thresholds';

describe('temperature thresholds', () => {
  it('treats minus twenty as normal for frozen goods', () => {
    expect(isBreach('frozen', -20)).to.equal(false);
  });

  it('treats minus twenty as a breach for chilled goods', () => {
    expect(isBreach('chilled', -20)).to.equal(true);
  });

  it('matches food types without case sensitivity', () => {
    expect(isBreach(' ChIlLeD ', 3)).to.equal(false);
  });

  it('falls back to the ambient range for an unknown food type', () => {
    expect(rangeFor('something-new')).to.deep.equal(DEFAULT_RANGE);
  });
});

interface Invocation {
  readonly chaincode: string;
  readonly args: string[];
  readonly channel: string;
}

interface TestContext {
  readonly ctx: Context;
  readonly state: Map<string, Buffer>;
  readonly invocations: Invocation[];
  setCaller: (attrs: Record<string, string>) => void;
  setChildren: (parent: string, children: string[]) => void;
}

const makeContext = (): TestContext => {
  const state = new Map<string, Buffer>();
  const invocations: Invocation[] = [];
  const children = new Map<string, string[]>();
  let attrs: Record<string, string> = {};

  const stub = {
    getState: async (key: string) => state.get(key) ?? Buffer.alloc(0),

    putState: async (key: string, value: Buffer) => {
      state.set(key, value);
    },

    createCompositeKey: (objectType: string, attributes: string[]) =>
      `\u0000${objectType}\u0000${attributes.join('\u0000')}\u0000`,

    invokeChaincode: async (
      chaincode: string,
      args: string[],
      channel: string,
    ) => {
      invocations.push({ chaincode, args, channel });
      const [transaction, batchId] = args;

      if (transaction === 'GetBatch') {
        return {
          status: 200,
          message: '',
          payload: Buffer.from(
            JSON.stringify({
              batchId,
              foodType: 'chilled',
            }),
          ),
        };
      }

      if (transaction === DERIVED_BATCH_QUERY) {
        return {
          status: 200,
          message: '',
          payload: Buffer.from(
            JSON.stringify(children.get(batchId) ?? []),
          ),
        };
      }

      return {
        status: 200,
        message: '',
        payload: Buffer.alloc(0),
      };
    },
  };

  const clientIdentity = {
    getAttributeValue: (name: string) =>
      name in attrs ? attrs[name] : null,
  };

  return {
    ctx: {
      stub,
      clientIdentity,
    } as unknown as Context,

    state,
    invocations,

    setCaller: (next) => {
      attrs = next;
    },

    setChildren: (parent, nextChildren) => {
      children.set(parent, nextChildren);
    },
  };
};

const compositeKey = (
  objectType: string,
  ...attributes: string[]
): string =>
  `\u0000${objectType}\u0000${attributes.join('\u0000')}\u0000`;

const expectFailure = async (
  work: Promise<unknown>,
  message: RegExp,
): Promise<void> => {
  try {
    await work;
    expect.fail('expected the operation to reject');
  } catch (error) {
    expect(String(error)).to.match(message);
  }
};

describe('ComplianceContract', () => {
  let contract: ComplianceContract;
  let test: TestContext;

  beforeEach(() => {
    contract = new ComplianceContract();
    test = makeContext();
  });

  it('does not flag a batch while readings stay inside the range', async () => {
    test.setCaller({ oracle: 'true' });

    await contract.SubmitTemperatureReading(
      test.ctx,
      'B1',
      '2',
      '100',
      'hash-100',
    );
    await contract.SubmitTemperatureReading(
      test.ctx,
      'B1',
      '3',
      '101',
      'hash-101',
    );
    await contract.SubmitTemperatureReading(
      test.ctx,
      'B1',
      '4',
      '102',
      'hash-102',
    );

    const flagCalls = test.invocations.filter(
      (call) => call.args[0] === 'FlagBatch',
    );
    expect(flagCalls).to.be.empty;

    const stored = JSON.parse(
      test.state
        .get(compositeKey(READING_INDEX, 'B1', '102'))!
        .toString(),
    ) as TemperatureReading;
    expect(stored.breach).to.equal(false);

    const violationState = JSON.parse(
      test.state
        .get(compositeKey(VIOLATION_STATE, 'B1'))!
        .toString(),
    ) as ViolationState;
    expect(violationState.consecutiveBreaches).to.equal(0);
  });

  it('flags the batch through invokeChaincode once the breach count is reached', async () => {
    test.setCaller({ oracle: 'true' });

    await contract.SubmitTemperatureReading(
      test.ctx,
      'B2',
      '8',
      '200',
      'hash-200',
    );
    await contract.SubmitTemperatureReading(
      test.ctx,
      'B2',
      '9',
      '201',
      'hash-201',
    );
    await contract.SubmitTemperatureReading(
      test.ctx,
      'B2',
      '10',
      '202',
      'hash-202',
    );
    await contract.SubmitTemperatureReading(
      test.ctx,
      'B2',
      '11',
      '203',
      'hash-203',
    );

    const flags = test.invocations.filter(
      (call) => call.args[0] === 'FlagBatch',
    );

    expect(flags).to.have.length(1);
    expect(flags[0].chaincode).to.equal('batch-registry');
    expect(flags[0].channel).to.equal('mychannel');
    expect(flags[0].args[1]).to.equal('B2');
    expect(flags[0].args[2]).to.contain(
      '3 consecutive temperature violations',
    );
    expect(flags[0].args[3]).to.equal('hash-202');
  });

  it('resets the consecutive breach count after a valid reading', async () => {
    test.setCaller({ oracle: 'true' });

    await contract.SubmitTemperatureReading(
      test.ctx,
      'B3',
      '8',
      '300',
      'hash-300',
    );
    await contract.SubmitTemperatureReading(
      test.ctx,
      'B3',
      '8',
      '301',
      'hash-301',
    );
    await contract.SubmitTemperatureReading(
      test.ctx,
      'B3',
      '2',
      '302',
      'hash-302',
    );
    await contract.SubmitTemperatureReading(
      test.ctx,
      'B3',
      '8',
      '303',
      'hash-303',
    );
    await contract.SubmitTemperatureReading(
      test.ctx,
      'B3',
      '8',
      '304',
      'hash-304',
    );

    const flags = test.invocations.filter(
      (call) => call.args[0] === 'FlagBatch',
    );
    expect(flags).to.be.empty;
  });

  it('rejects a reading submitted by a non-oracle identity', async () => {
    test.setCaller({ role: 'transporter' });

    await expectFailure(
      contract.SubmitTemperatureReading(
        test.ctx,
        'B4',
        '2',
        '400',
        'hash-400',
      ),
      /access denied/,
    );

    expect(test.invocations).to.be.empty;
  });

  it('rejects duplicate and out-of-order observations', async () => {
    test.setCaller({ oracle: 'true' });

    await contract.SubmitTemperatureReading(
      test.ctx,
      'B5',
      '2',
      '500',
      'hash-500',
    );

    await expectFailure(
      contract.SubmitTemperatureReading(
        test.ctx,
        'B5',
        '2',
        '500',
        'hash-duplicate',
      ),
      /already exists/,
    );

    await expectFailure(
      contract.SubmitTemperatureReading(
        test.ctx,
        'B5',
        '2',
        '499',
        'hash-old',
      ),
      /must be later/,
    );
  });

  it('allows a regulator to flag a batch manually', async () => {
    test.setCaller({ role: 'regulator' });

    await contract.FlagByRegulator(
      test.ctx,
      'B6',
      'failed inspection',
      'report-hash',
    );

    const flag = test.invocations.find(
      (call) => call.args[0] === 'FlagBatch',
    );

    expect(flag?.args).to.deep.equal([
      'FlagBatch',
      'B6',
      'failed inspection',
      'report-hash',
    ]);
  });

  it('rejects manual flagging and recall by a non-regulator', async () => {
    test.setCaller({ role: 'producer' });

    await expectFailure(
      contract.FlagByRegulator(
        test.ctx,
        'B7',
        'reason',
        'hash',
      ),
      /regulator/,
    );

    await expectFailure(
      contract.RecallBatch(test.ctx, 'B7'),
      /regulator/,
    );

    expect(test.invocations).to.be.empty;
  });

  it('cascades a recall to downstream batches', async () => {
    test.setCaller({ role: 'regulator' });

    test.setChildren('ROOT', ['CHILD-A', 'CHILD-B']);
    test.setChildren('CHILD-A', ['GRANDCHILD']);
    test.setChildren('CHILD-B', []);
    test.setChildren('GRANDCHILD', []);

    await contract.RecallBatch(test.ctx, 'ROOT');

    const flags = test.invocations
      .filter((call) => call.args[0] === 'FlagBatch')
      .map((call) => call.args[1]);

    const recalls = test.invocations
      .filter((call) => call.args[0] === 'RecallBatch')
      .map((call) => call.args[1]);

    expect(flags).to.deep.equal([
      'ROOT',
      'CHILD-A',
      'CHILD-B',
      'GRANDCHILD',
    ]);

    expect(recalls).to.deep.equal([
      'ROOT',
      'CHILD-A',
      'CHILD-B',
      'GRANDCHILD',
    ]);
  });

  it('does not loop forever if malformed derived data contains a cycle', async () => {
    test.setCaller({ role: 'regulator' });

    test.setChildren('A', ['B']);
    test.setChildren('B', ['A']);

    await contract.RecallBatch(test.ctx, 'A');

    const recalls = test.invocations.filter(
      (call) => call.args[0] === 'RecallBatch',
    );

    expect(recalls.map((call) => call.args[1])).to.deep.equal([
      'A',
      'B',
    ]);
  });
});
