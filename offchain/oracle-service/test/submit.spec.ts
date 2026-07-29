import { expect } from 'chai';
import {
  toReadingArgs,
  submitVia,
  runOracleCycle,
  ChaincodeSubmitter,
  RawSeriesStore,
  Reading,
  Summary,
} from '../src';

const summary: Summary = { batchId: 'B1', meanC: 3.33, maxC: 5, minC: 1, observedAt: 1700 };

interface RecordingSubmitter extends ChaincodeSubmitter {
  readonly calls: Array<{ name: string; args: string[] }>;
}

const recordingSubmitter = (): RecordingSubmitter => {
  const calls: Array<{ name: string; args: string[] }> = [];
  return {
    calls,
    async submitTransaction(name: string, ...args: string[]): Promise<Uint8Array> {
      calls.push({ name, args });
      return new Uint8Array();
    },
  };
};

interface RecordingStore extends RawSeriesStore {
  readonly puts: Array<{ payload: Buffer; contentType: string }>;
}

const recordingStore = (hash: string): RecordingStore => {
  const puts: Array<{ payload: Buffer; contentType: string }> = [];
  return {
    puts,
    async put(payload: Buffer, contentType: string): Promise<{ readonly hash: string }> {
      puts.push({ payload, contentType });
      return { hash };
    },
  };
};

describe('toReadingArgs', () => {
  it('maps a summary and hash to the chaincode arg order (worst-case temp), all as strings', () => {
    // representativeTempC sends the max (5), not the mean (3.33).
    expect(toReadingArgs(summary, 'HASH')).to.deep.equal(['B1', '5', '1700', 'HASH']);
  });
});

describe('submitVia', () => {
  it('calls the qualified SubmitTemperatureReading with the mapped args', async () => {
    const submitter = recordingSubmitter();
    await submitVia(submitter, summary, 'HASH');
    expect(submitter.calls).to.have.length(1);
    expect(submitter.calls[0].name).to.equal('ComplianceContract:SubmitTemperatureReading');
    expect(submitter.calls[0].args).to.deep.equal(['B1', '5', '1700', 'HASH']);
  });
});

describe('runOracleCycle', () => {
  const readings: Reading[] = [
    { batchId: 'B1', tempC: 1, observedAt: 1500 },
    { batchId: 'B1', tempC: 5, observedAt: 1700 },
  ];

  it('stores the raw series as JSON and submits the summary anchored by its hash', async () => {
    const store = recordingStore('RAWHASH');
    const submitter = recordingSubmitter();

    const result = await runOracleCycle(readings, store, submitter);

    // Raw series persisted verbatim.
    expect(store.puts).to.have.length(1);
    expect(store.puts[0].contentType).to.equal('application/json');
    expect(JSON.parse(store.puts[0].payload.toString())).to.deep.equal(readings);

    // Submitted with the storage hash and the worst-case reading (max of 1 and 5 is 5).
    expect(submitter.calls[0].args).to.deep.equal(['B1', '5', '1700', 'RAWHASH']);

    // Returns the summary it computed.
    expect(result.batchId).to.equal('B1');
    expect(result.maxC).to.equal(5);
    expect(result.minC).to.equal(1);
  });
});
