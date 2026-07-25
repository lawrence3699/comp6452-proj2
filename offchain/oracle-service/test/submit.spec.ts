import { expect } from 'chai';
import * as sinon from 'sinon';
import { GatewayConnection, loadConfig } from '@comp6452/offchain-shared';
import { complianceContractName, oracleConfig, submit, submitWith } from '../src/submit';
import { Summary } from '../src/summarise';

const VALID_HASH = 'a'.repeat(64);

const summary: Summary = {
  batchId: 'BATCH-1',
  meanC: -18.456,
  maxC: -17,
  minC: -20,
  observedAt: 1_750_000_000,
};

/**
 * A gateway stubbed all the way down, so the argument marshalling that reaches
 * the peer is asserted with no network, no TLS and no crypto material.
 */
const fakeConnection = (options: { commitSuccessful?: boolean; code?: number } = {}) => {
  const commit = {
    getStatus: sinon.stub().resolves({
      successful: options.commitSuccessful ?? true,
      code: options.code ?? 0,
    }),
    getTransactionId: sinon.stub().returns('tx-abc'),
  };
  const transaction = { submit: sinon.stub().resolves(commit) };
  const proposal = { endorse: sinon.stub().resolves(transaction) };
  const contract = { newProposal: sinon.stub().returns(proposal) };
  const network = { getContract: sinon.stub().returns(contract) };
  const gateway = { getNetwork: sinon.stub().returns(network), close: sinon.stub() };

  const connection = {
    gateway,
    config: loadConfig(),
    close: sinon.stub(),
    // The stub implements only the slice of the gateway surface submitWith
    // touches; casting through unknown keeps the rest of the file type-safe.
  } as unknown as GatewayConnection;

  return { connection, gateway, network, contract, proposal, transaction, commit };
};

describe('submit', () => {
  afterEach(() => {
    sinon.restore();
    delete process.env.ORACLE_REPORT_STAT;
    delete process.env.COMPLIANCE_CONTRACT_NAME;
  });

  it('calls SubmitTemperatureReading with all arguments as strings', async () => {
    const fake = fakeConnection();

    const txId = await submitWith(fake.connection, summary, VALID_HASH);

    expect(txId).to.equal('tx-abc');
    const [functionName, options] = fake.contract.newProposal.firstCall.args as [
      string,
      { arguments: string[] },
    ];
    expect(functionName).to.equal('SubmitTemperatureReading');
    expect(options.arguments.every((arg) => typeof arg === 'string')).to.equal(true);
    expect(options.arguments).to.deep.equal([
      'BATCH-1',
      '-18.46',
      '1750000000',
      VALID_HASH,
    ]);
  });

  it('addresses the compliance chaincode and its named contract', async () => {
    const fake = fakeConnection();

    await submitWith(fake.connection, summary, VALID_HASH);

    // The bare function name is ambiguous when a chaincode registers more than
    // one contract, so the contract name must be supplied.
    expect(fake.network.getContract.firstCall.args).to.deep.equal([
      'coldchain-compliance',
      'ComplianceContract',
    ]);
  });

  it('reports the max instead of the mean when ORACLE_REPORT_STAT=max', async () => {
    process.env.ORACLE_REPORT_STAT = 'max';
    const fake = fakeConnection();

    await submitWith(fake.connection, summary, VALID_HASH);

    const options = fake.contract.newProposal.firstCall.args[1] as { arguments: string[] };
    expect(options.arguments[1]).to.equal('-17.00');
  });

  it('endorses and submits exactly once, then waits for the commit status', async () => {
    const fake = fakeConnection();

    await submitWith(fake.connection, summary, VALID_HASH);

    expect(fake.proposal.endorse.calledOnce).to.equal(true);
    expect(fake.transaction.submit.calledOnce).to.equal(true);
    expect(fake.commit.getStatus.calledOnce).to.equal(true);
  });

  it('throws when the transaction does not commit', async () => {
    const fake = fakeConnection({ commitSuccessful: false, code: 11 });

    let thrown: Error | undefined;
    try {
      await submitWith(fake.connection, summary, VALID_HASH);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).to.contain('failed to commit');
    expect(thrown?.message).to.contain('11');
  });

  it('rejects a malformed rawDataHash before contacting the peer', async () => {
    const fake = fakeConnection();

    let thrown: Error | undefined;
    try {
      await submitWith(fake.connection, summary, 'not-a-hash');
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).to.contain('hex SHA-256');
    expect(fake.contract.newProposal.called).to.equal(false);
  });

  it('rejects an empty batchId', async () => {
    const fake = fakeConnection();

    let thrown: Error | undefined;
    try {
      await submitWith(fake.connection, { ...summary, batchId: '' }, VALID_HASH);
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).to.contain('batchId');
  });

  it('validates before opening a connection, so a bad hash fails without a network', async () => {
    // No Fabric network is running under unit test; if submit() dialled first
    // this would surface as a gRPC/crypto error instead of the argument error.
    let thrown: Error | undefined;
    try {
      await submit(summary, 'short');
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).to.contain('hex SHA-256');
  });

  it('takes the contract name from the environment when overridden', () => {
    process.env.COMPLIANCE_CONTRACT_NAME = 'OtherContract';
    expect(complianceContractName()).to.equal('OtherContract');
  });

  describe('oracleConfig', () => {
    afterEach(() => {
      delete process.env.FABRIC_USER;
      delete process.env.ORACLE_USER;
    });

    it('signs as the oracle1 identity by default', () => {
      // SubmitTemperatureReading only accepts a cert carrying oracle=true, so
      // the generic User1 default would be rejected by the chaincode.
      expect(oracleConfig().certDirectoryPath).to.contain('oracle1@');
    });

    it('honours ORACLE_USER and FABRIC_USER overrides', () => {
      process.env.ORACLE_USER = 'oracle2';
      expect(oracleConfig().certDirectoryPath).to.contain('oracle2@');

      process.env.FABRIC_USER = 'oracle3';
      expect(oracleConfig().certDirectoryPath).to.contain('oracle3@');
    });

    it('does not mutate FABRIC_USER as a side effect', () => {
      oracleConfig();

      expect(process.env.FABRIC_USER).to.equal(undefined);
    });
  });
});
