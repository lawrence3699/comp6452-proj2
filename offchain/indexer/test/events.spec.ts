import { expect } from 'chai';
import {
  EventDecodeError,
  RawChaincodeEvent,
  decodeEvent,
  eventKey,
  isEventName,
  tryDecodeEvent,
} from '../src/events';

/**
 * Event decoding is a pure function over a fabricated event object, so the
 * whole suite runs with no Fabric network and no gateway — exactly the same
 * discipline the chaincode tests use with a sinon-stubbed ChaincodeStub.
 */
const rawEvent = (
  eventName: string,
  payload: unknown,
  overrides: Partial<RawChaincodeEvent> = {},
): RawChaincodeEvent => ({
  blockNumber: 7n,
  transactionId: 'tx-abc',
  chaincodeName: 'batch-registry',
  eventName,
  payload:
    payload instanceof Uint8Array
      ? payload
      : new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload)),
  ...overrides,
});

describe('event decoding', () => {
  describe('BatchRegistered', () => {
    it('decodes a well-formed payload and keeps the ledger provenance', () => {
      const decoded = decodeEvent(
        rawEvent('BatchRegistered', {
          batchId: 'BATCH-1',
          producer: 'producer1',
          timestamp: 1_700_000_000,
        }),
      );

      expect(decoded).to.deep.equal({
        eventName: 'BatchRegistered',
        batchId: 'BATCH-1',
        producer: 'producer1',
        timestamp: 1_700_000_000,
        blockNumber: 7,
        transactionId: 'tx-abc',
        chaincodeName: 'batch-registry',
      });
    });

    it('rejects a payload missing a required field', () => {
      expect(() =>
        decodeEvent(rawEvent('BatchRegistered', { batchId: 'BATCH-1', timestamp: 1 })),
      ).to.throw(EventDecodeError, /"producer" must be a string/);
    });

    it('rejects an empty string field rather than indexing a blank producer', () => {
      expect(() =>
        decodeEvent(
          rawEvent('BatchRegistered', { batchId: 'BATCH-1', producer: '', timestamp: 1 }),
        ),
      ).to.throw(EventDecodeError, /"producer" must not be empty/);
    });
  });

  describe('CustodyTransferred', () => {
    it('decodes from/to and normalises a stringified timestamp', () => {
      const decoded = decodeEvent(
        rawEvent('CustodyTransferred', {
          batchId: 'BATCH-1',
          from: 'producer1',
          to: 'transporter1',
          timestamp: '1700000500',
        }),
      );

      expect(decoded).to.include({
        eventName: 'CustodyTransferred',
        from: 'producer1',
        to: 'transporter1',
        timestamp: 1_700_000_500,
      });
    });

    it('accepts a protobuf-shaped { seconds, nanos } timestamp', () => {
      const decoded = decodeEvent(
        rawEvent('CustodyTransferred', {
          batchId: 'BATCH-1',
          from: 'a',
          to: 'b',
          timestamp: { seconds: 1_700_000_600, nanos: 123 },
        }),
      );

      expect(decoded.timestamp).to.equal(1_700_000_600);
    });
  });

  describe('BatchFlagged', () => {
    it('decodes the reason and evidence hash', () => {
      const decoded = decodeEvent(
        rawEvent('BatchFlagged', {
          batchId: 'BATCH-1',
          reason: 'temperature breach',
          evidenceHash: 'a'.repeat(64),
          timestamp: 1_700_001_000,
        }),
      );

      expect(decoded).to.include({
        eventName: 'BatchFlagged',
        reason: 'temperature breach',
        evidenceHash: 'a'.repeat(64),
      });
    });
  });

  describe('BatchDelivered', () => {
    it('decodes the delivering holder', () => {
      const decoded = decodeEvent(
        rawEvent('BatchDelivered', {
          batchId: 'BATCH-1',
          holder: 'Org2MSP',
          timestamp: 1_700_002_000,
        }),
      );

      expect(decoded).to.include({
        eventName: 'BatchDelivered',
        batchId: 'BATCH-1',
        holder: 'Org2MSP',
        timestamp: 1_700_002_000,
      });
    });

    it('rejects a payload missing the holder', () => {
      expect(() =>
        decodeEvent(rawEvent('BatchDelivered', { batchId: 'BATCH-1', timestamp: 1 })),
      ).to.throw(EventDecodeError, /"holder" must be a string/);
    });

    it('rejects an empty holder rather than indexing a blank MSP', () => {
      expect(() =>
        decodeEvent(rawEvent('BatchDelivered', { batchId: 'BATCH-1', holder: '', timestamp: 1 })),
      ).to.throw(EventDecodeError, /"holder" must not be empty/);
    });
  });

  describe('BatchRecalled', () => {
    it('decodes the minimal batchId + timestamp payload', () => {
      const decoded = decodeEvent(
        rawEvent('BatchRecalled', { batchId: 'BATCH-1', timestamp: 1_700_003_000 }),
      );

      expect(decoded).to.include({
        eventName: 'BatchRecalled',
        batchId: 'BATCH-1',
        timestamp: 1_700_003_000,
      });
    });

    it('rejects a payload missing the timestamp', () => {
      expect(() => decodeEvent(rawEvent('BatchRecalled', { batchId: 'BATCH-1' }))).to.throw(
        EventDecodeError,
        /"timestamp" must be a number or numeric string/,
      );
    });
  });

  describe('ComplianceBreach', () => {
    it('decodes the numeric breach fields and the evidence hash', () => {
      const decoded = decodeEvent(
        rawEvent('ComplianceBreach', {
          batchId: 'BATCH-1',
          consecutive: 3,
          tempC: 9.5,
          rawDataHash: 'c'.repeat(64),
          timestamp: 1_700_004_000,
        }),
      );

      expect(decoded).to.include({
        eventName: 'ComplianceBreach',
        batchId: 'BATCH-1',
        consecutive: 3,
        tempC: 9.5,
        rawDataHash: 'c'.repeat(64),
        timestamp: 1_700_004_000,
      });
    });

    it('rejects a stringified consecutive count — numbers are validated, not cast', () => {
      expect(() =>
        decodeEvent(
          rawEvent('ComplianceBreach', {
            batchId: 'B',
            consecutive: '3',
            tempC: 9.5,
            rawDataHash: 'c'.repeat(64),
            timestamp: 1,
          }),
        ),
      ).to.throw(EventDecodeError, /"consecutive" must be a number, got string/);
    });

    it('rejects a non-finite temperature, which JSON.parse can produce from 1e999', () => {
      expect(() =>
        decodeEvent(
          rawEvent(
            'ComplianceBreach',
            // Hand-built JSON: 1e999 parses to Infinity, which JSON.stringify
            // would round-trip to null and hide the case being tested.
            `{"batchId":"B","consecutive":3,"tempC":1e999,"rawDataHash":"${'c'.repeat(64)}","timestamp":1}`,
          ),
        ),
      ).to.throw(EventDecodeError, /"tempC" is not a finite number/);
    });

    it('rejects a payload missing the rawDataHash', () => {
      expect(() =>
        decodeEvent(
          rawEvent('ComplianceBreach', { batchId: 'B', consecutive: 3, tempC: 9.5, timestamp: 1 }),
        ),
      ).to.throw(EventDecodeError, /"rawDataHash" must be a string/);
    });
  });

  describe('RecallCascaded', () => {
    it('decodes batchId from the wire field `root` and keeps the recalled list', () => {
      const decoded = decodeEvent(
        rawEvent('RecallCascaded', {
          root: 'BATCH-1',
          recalled: ['BATCH-1', 'BATCH-1-SPLIT'],
          timestamp: 1_700_005_000,
        }),
      );

      expect(decoded.batchId).to.equal('BATCH-1');
      expect(decoded.eventName).to.equal('RecallCascaded');
      if (decoded.eventName === 'RecallCascaded') {
        expect(decoded.recalled).to.deep.equal(['BATCH-1', 'BATCH-1-SPLIT']);
      }
      expect(decoded.timestamp).to.equal(1_700_005_000);
    });

    it('accepts an empty recalled list — a cascade over a leaf batch is legal', () => {
      const decoded = decodeEvent(
        rawEvent('RecallCascaded', { root: 'BATCH-1', recalled: [], timestamp: 1 }),
      );

      if (decoded.eventName === 'RecallCascaded') {
        expect(decoded.recalled).to.deep.equal([]);
      }
    });

    it('rejects a payload whose recalled field is not an array', () => {
      expect(() =>
        decodeEvent(rawEvent('RecallCascaded', { root: 'B', recalled: 'B2', timestamp: 1 })),
      ).to.throw(EventDecodeError, /"recalled" must be an array, got string/);
    });

    it('rejects a recalled entry that is not a string', () => {
      expect(() =>
        decodeEvent(rawEvent('RecallCascaded', { root: 'B', recalled: ['B2', 3], timestamp: 1 })),
      ).to.throw(EventDecodeError, /"recalled"\[1\] must be a string, got number/);
    });

    it('rejects an empty string inside recalled rather than indexing a blank batch id', () => {
      expect(() =>
        decodeEvent(rawEvent('RecallCascaded', { root: 'B', recalled: [''], timestamp: 1 })),
      ).to.throw(EventDecodeError, /"recalled"\[0\] must not be empty/);
    });

    it('rejects a payload using batchId instead of the wire field root', () => {
      expect(() =>
        decodeEvent(rawEvent('RecallCascaded', { batchId: 'B', recalled: [], timestamp: 1 })),
      ).to.throw(EventDecodeError, /"root" must be a string/);
    });
  });

  describe('defensive parsing', () => {
    it('rejects a payload that is not JSON', () => {
      expect(() => decodeEvent(rawEvent('BatchRegistered', 'not json at all'))).to.throw(
        EventDecodeError,
        /payload is not JSON/,
      );
    });

    it('rejects an empty payload', () => {
      expect(() => decodeEvent(rawEvent('BatchRegistered', ''))).to.throw(
        EventDecodeError,
        /payload is empty/,
      );
    });

    it('rejects a JSON array, which would read as an object with no fields', () => {
      expect(() => decodeEvent(rawEvent('BatchRegistered', ['BATCH-1']))).to.throw(
        EventDecodeError,
        /not a JSON object/,
      );
    });

    it('rejects JSON null', () => {
      expect(() => decodeEvent(rawEvent('BatchRegistered', null))).to.throw(
        EventDecodeError,
        /not a JSON object/,
      );
    });

    it('rejects invalid UTF-8 rather than decoding replacement characters', () => {
      // 0xff is never a legal UTF-8 byte.
      expect(() =>
        decodeEvent(rawEvent('BatchRegistered', new Uint8Array([0x7b, 0xff, 0x7d]))),
      ).to.throw(EventDecodeError, /not valid UTF-8/);
    });

    it('rejects an unknown event name', () => {
      expect(() => decodeEvent(rawEvent('SomethingElse', { batchId: 'B' }))).to.throw(
        EventDecodeError,
        /unknown event name: SomethingElse/,
      );
    });

    it('rejects a negative timestamp', () => {
      expect(() =>
        decodeEvent(rawEvent('BatchRegistered', { batchId: 'B', producer: 'p', timestamp: -1 })),
      ).to.throw(EventDecodeError, /must not be negative/);
    });

    it('rejects a block number beyond the safe integer range', () => {
      expect(() =>
        decodeEvent(
          rawEvent(
            'BatchRegistered',
            { batchId: 'B', producer: 'p', timestamp: 1 },
            { blockNumber: BigInt(Number.MAX_SAFE_INTEGER) + 10n },
          ),
        ),
      ).to.throw(EventDecodeError, /exceeds the safe integer range/);
    });

    it('rejects an event with no transaction id', () => {
      expect(() =>
        decodeEvent(
          rawEvent(
            'BatchRegistered',
            { batchId: 'B', producer: 'p', timestamp: 1 },
            { transactionId: '' },
          ),
        ),
      ).to.throw(EventDecodeError, /no transaction id/);
    });
  });

  describe('tryDecodeEvent', () => {
    it('returns undefined and reports the reason instead of throwing', () => {
      const reasons: string[] = [];
      const result = tryDecodeEvent(rawEvent('BatchRegistered', 'garbage'), (reason) =>
        reasons.push(reason),
      );

      expect(result).to.equal(undefined);
      expect(reasons).to.have.lengthOf(1);
      expect(reasons[0]).to.match(/skipped event "BatchRegistered" in block 7 tx tx-abc/);
    });

    it('returns the decoded event when the payload is good', () => {
      const result = tryDecodeEvent(
        rawEvent('BatchRegistered', { batchId: 'B', producer: 'p', timestamp: 1 }),
      );

      expect(result?.batchId).to.equal('B');
    });
  });

  describe('helpers', () => {
    it('recognises exactly the seven frozen event names', () => {
      expect(isEventName('BatchRegistered')).to.equal(true);
      expect(isEventName('CustodyTransferred')).to.equal(true);
      expect(isEventName('BatchFlagged')).to.equal(true);
      expect(isEventName('BatchDelivered')).to.equal(true);
      expect(isEventName('BatchRecalled')).to.equal(true);
      expect(isEventName('ComplianceBreach')).to.equal(true);
      expect(isEventName('RecallCascaded')).to.equal(true);
      expect(isEventName('TemperatureRecorded')).to.equal(false);
    });

    it('keys an event on block, transaction and event name', () => {
      const decoded = decodeEvent(
        rawEvent('BatchRegistered', { batchId: 'B', producer: 'p', timestamp: 1 }),
      );
      expect(eventKey(decoded)).to.equal('7:tx-abc:BatchRegistered');
    });
  });
});
