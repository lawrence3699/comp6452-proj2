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
    it('recognises exactly the three frozen event names', () => {
      expect(isEventName('BatchRegistered')).to.equal(true);
      expect(isEventName('CustodyTransferred')).to.equal(true);
      expect(isEventName('BatchFlagged')).to.equal(true);
      expect(isEventName('BatchRecalled')).to.equal(false);
    });

    it('keys an event on block, transaction and event name', () => {
      const decoded = decodeEvent(
        rawEvent('BatchRegistered', { batchId: 'B', producer: 'p', timestamp: 1 }),
      );
      expect(eventKey(decoded)).to.equal('7:tx-abc:BatchRegistered');
    });
  });
});
