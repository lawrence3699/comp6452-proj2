import * as path from 'node:path';
import { expect } from 'chai';
import { closeConnection, configFromFile, connectAs, getContract, Connection } from '../src/connect';

const REGISTRY_CHAINCODE = 'batch-registry';
const COMPLIANCE_CHAINCODE = 'coldchain-compliance';

// Written by network/scripts/setupDemoIdentities.sh; override per-variable if
// your identities live somewhere else.
const identitiesDir = path.join(__dirname, '..', '..', '..', 'network', 'identities');
const envPath = (name: string): string =>
  process.env[`${name.toUpperCase()}_ENV_PATH`] ?? path.join(identitiesDir, `${name}.env`);

interface Batch {
  readonly batchId: string;
  readonly status: string;
  readonly currentHolder: string;
}

/**
 * Required path from README.md: register, move custody, breach the cold
 * chain, get flagged automatically, and have a regulator read the full
 * history back — end to end, against a live network rather than a mock.
 */
describe('cold chain traceability (end to end)', function () {
  this.timeout(60_000);

  let producer: Connection;
  let transporter: Connection;
  let oracle: Connection;
  let regulator: Connection;
  const batchId = `e2e-${Date.now()}`;

  before(async () => {
    producer = await connectAs(await configFromFile(envPath('producer1')));
    transporter = await connectAs(await configFromFile(envPath('transporter1')));
    oracle = await connectAs(await configFromFile(envPath('oracle1')));
    regulator = await connectAs(await configFromFile(envPath('regulator1')));
  });

  after(() => {
    [producer, transporter, oracle, regulator].forEach((c) => c && closeConnection(c));
  });

  it('producer registers a batch', async () => {
    const config = await configFromFile(envPath('producer1'));
    const contract = getContract(producer, config, REGISTRY_CHAINCODE);

    const batchJson = JSON.stringify({
      batchId,
      foodType: 'chilled',
      producedAt: Math.floor(Date.now() / 1000),
      shelfLifeDays: 14,
      origin: 'Farm A',
      quantity: 500,
    });

    await contract.submit('BatchRegistryContract:RegisterBatch', {
      arguments: [batchJson],
      transientData: {
        batch_private_details: JSON.stringify({ batchId, unitPrice: 3.5, inspectionNotes: 'ok' }),
      },
    });

    const raw = await contract.evaluateTransaction('BatchRegistryContract:GetBatch', batchId);
    const batch = JSON.parse(Buffer.from(raw).toString()) as Batch;
    expect(batch.status).to.equal('CREATED');
  });

  it('custody moves from producer to transporter to warehouse', async () => {
    const producerConfig = await configFromFile(envPath('producer1'));
    const producerContract = getContract(producer, producerConfig, REGISTRY_CHAINCODE);
    await producerContract.submitTransaction(
      'BatchRegistryContract:TransferCustody',
      batchId,
      'Org2MSP',
    );

    const transporterConfig = await configFromFile(envPath('transporter1'));
    const transporterContract = getContract(transporter, transporterConfig, REGISTRY_CHAINCODE);
    await transporterContract.submitTransaction(
      'BatchRegistryContract:TransferCustody',
      batchId,
      'Org1MSP',
    );

    const raw = await transporterContract.evaluateTransaction('BatchRegistryContract:GetBatch', batchId);
    const batch = JSON.parse(Buffer.from(raw).toString()) as Batch;
    expect(batch.status).to.equal('AT_WAREHOUSE');
  });

  it('the oracle submits readings that breach the cold chain range', async () => {
    const config = await configFromFile(envPath('oracle1'));
    const contract = getContract(oracle, config, COMPLIANCE_CHAINCODE);

    // 'chilled' batches must stay between 0C and 4C (thresholds.ts) — 15C is
    // a breach on every reading. VIOLATIONS_BEFORE_FLAG readings are needed
    // before coldchain-compliance calls into batch-registry to flag it.
    for (let i = 0; i < 3; i++) {
      await contract.submitTransaction(
        'ComplianceContract:SubmitTemperatureReading',
        batchId,
        '15',
        String(Math.floor(Date.now() / 1000) + i),
        `raw-hash-${i}`,
      );
    }
  });

  it('coldchain-compliance flags the batch through invokeChaincode', async () => {
    const config = await configFromFile(envPath('regulator1'));
    const contract = getContract(regulator, config, REGISTRY_CHAINCODE);
    const raw = await contract.evaluateTransaction('BatchRegistryContract:GetBatch', batchId);
    const batch = JSON.parse(Buffer.from(raw).toString()) as Batch;
    expect(batch.status).to.equal('FLAGGED');
  });

  it('the regulator reads back the complete history, including the flag', async () => {
    const config = await configFromFile(envPath('regulator1'));
    const contract = getContract(regulator, config, REGISTRY_CHAINCODE);
    const raw = await contract.evaluateTransaction('BatchQueryContract:GetBatchHistory', batchId);
    const history = JSON.parse(Buffer.from(raw).toString()) as { value: Batch | null }[];

    expect(history.length).to.be.greaterThan(0);
    expect(history[history.length - 1].value?.status).to.equal('FLAGGED');
  });
});
