/**
 * Chaincode event decoding — owner: person 3.
 *
 * The whole point of this module is that it never touches the network and
 * never throws out of the listener's hot loop. `decodeEvent` is a pure
 * function over a plain object, so the unit tests fabricate events directly
 * and the listener is reduced to "iterate, decode, persist".
 *
 * Everything a peer hands us is attacker-influenced in the general case: the
 * payload is whatever bytes some chaincode called `SetEvent` with. So the
 * decode path validates rather than casts, and the listener treats a decode
 * failure as a skipped record, not a crash.
 */

/**
 * The three events frozen in docs/interfaces.md. Declared as a const tuple so
 * `isEventName` and the type stay in sync — adding a fourth event means
 * touching exactly one line.
 */
export const EVENT_NAMES = ['BatchRegistered', 'CustodyTransferred', 'BatchFlagged'] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const isEventName = (value: string): value is EventName =>
  (EVENT_NAMES as readonly string[]).includes(value);

/**
 * Structural mirror of `@hyperledger/fabric-gateway`'s `ChaincodeEvent`.
 *
 * Declared locally rather than imported so the decoder — and therefore the
 * test suite — has no dependency on the gateway or on protobuf. The real
 * `ChaincodeEvent` is assignable to this, which is checked for real in
 * `listen.ts` where the two meet.
 */
export interface RawChaincodeEvent {
  readonly blockNumber: bigint;
  readonly transactionId: string;
  readonly chaincodeName: string;
  readonly eventName: string;
  readonly payload: Uint8Array;
}

export interface BatchRegisteredPayload {
  readonly batchId: string;
  readonly producer: string;
  readonly timestamp: number;
}

export interface CustodyTransferredPayload {
  readonly batchId: string;
  readonly from: string;
  readonly to: string;
  readonly timestamp: number;
}

export interface BatchFlaggedPayload {
  readonly batchId: string;
  readonly reason: string;
  readonly evidenceHash: string;
  readonly timestamp: number;
}

export type EventPayload =
  | ({ readonly eventName: 'BatchRegistered' } & BatchRegisteredPayload)
  | ({ readonly eventName: 'CustodyTransferred' } & CustodyTransferredPayload)
  | ({ readonly eventName: 'BatchFlagged' } & BatchFlaggedPayload);

/**
 * One decoded, ledger-anchored event as it is written to the JSONL store.
 *
 * `blockNumber` and `transactionId` are kept because they are the only
 * provenance a reader can re-check against the ledger — a history served from
 * this index is verifiable precisely because every row names the block it came
 * from.
 */
export type IndexedEvent = EventPayload & {
  /** Block that committed the transaction emitting this event. */
  readonly blockNumber: number;
  /** Transaction that emitted the event; unique within the block. */
  readonly transactionId: string;
  /** Chaincode that emitted the event, e.g. `batch-registry`. */
  readonly chaincodeName: string;
};

/** Raised when a payload cannot be trusted. Carries the reason for the log line. */
export class EventDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventDecodeError';
  }
}

/**
 * Block numbers are `bigint` on the wire because Fabric's block height is a
 * uint64. We store a `number`, which is lossless up to 2^53 — about nine
 * quadrillion blocks — and refuse anything beyond that rather than silently
 * rounding. Storing a number keeps the JSONL rows plain JSON (JSON.stringify
 * throws on bigint) and lets the sort comparator be ordinary arithmetic.
 */
const toBlockNumber = (blockNumber: bigint): number => {
  if (blockNumber < 0n) {
    throw new EventDecodeError(`negative block number: ${blockNumber.toString()}`);
  }
  if (blockNumber > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EventDecodeError(
      `block number ${blockNumber.toString()} exceeds the safe integer range`,
    );
  }
  return Number(blockNumber);
};

/** `fatal: true` turns invalid UTF-8 into a throw instead of U+FFFD soup we would then "successfully" parse. */
const utf8 = new TextDecoder('utf-8', { fatal: true });

const decodeUtf8 = (payload: Uint8Array): string => {
  try {
    return utf8.decode(payload);
  } catch {
    throw new EventDecodeError('payload is not valid UTF-8');
  }
};

const parseJsonObject = (text: string): Record<string, unknown> => {
  if (text.trim() === '') {
    throw new EventDecodeError('payload is empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new EventDecodeError(
      `payload is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // `typeof null === 'object'`, and an array would pass a naive object check
  // while every field lookup below silently returned undefined.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EventDecodeError('payload is not a JSON object');
  }
  return parsed as Record<string, unknown>;
};

const requiredString = (record: Record<string, unknown>, field: string): string => {
  const value = record[field];
  if (typeof value !== 'string') {
    throw new EventDecodeError(`field "${field}" must be a string, got ${typeof value}`);
  }
  if (value === '') {
    throw new EventDecodeError(`field "${field}" must not be empty`);
  }
  return value;
};

/**
 * Timestamps come from `ctx.stub.getTxTimestamp()`, and how a contract renders
 * that is up to its author: a seconds number, the same value stringified by
 * the `JSON.stringify` of a protobuf Long, or the raw `{seconds, nanos}`
 * struct. All three mean the same instant, so all three are accepted and
 * normalised to integer seconds — rejecting two of them would make the indexer
 * fail on a chaincode change that is not actually a bug.
 */
const requiredTimestamp = (record: Record<string, unknown>, field: string): number => {
  const raw = record[field];
  const scalar =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)['seconds']
      : raw;

  if (typeof scalar !== 'number' && typeof scalar !== 'string') {
    throw new EventDecodeError(`field "${field}" must be a number or numeric string`);
  }
  // Number('') === 0, and an empty timestamp is a bug we want to see.
  if (typeof scalar === 'string' && scalar.trim() === '') {
    throw new EventDecodeError(`field "${field}" must not be empty`);
  }
  const value = Number(scalar);
  if (!Number.isFinite(value)) {
    throw new EventDecodeError(`field "${field}" is not a finite number: ${String(scalar)}`);
  }
  if (value < 0) {
    throw new EventDecodeError(`field "${field}" must not be negative: ${String(value)}`);
  }
  // Fractional seconds would make two renderings of the same instant compare
  // unequal, so truncate to the resolution the ledger actually orders on.
  return Math.trunc(value);
};

const decodePayload = (eventName: EventName, record: Record<string, unknown>): EventPayload => {
  switch (eventName) {
    case 'BatchRegistered':
      return {
        eventName,
        batchId: requiredString(record, 'batchId'),
        producer: requiredString(record, 'producer'),
        timestamp: requiredTimestamp(record, 'timestamp'),
      };
    case 'CustodyTransferred':
      return {
        eventName,
        batchId: requiredString(record, 'batchId'),
        from: requiredString(record, 'from'),
        to: requiredString(record, 'to'),
        timestamp: requiredTimestamp(record, 'timestamp'),
      };
    case 'BatchFlagged':
      return {
        eventName,
        batchId: requiredString(record, 'batchId'),
        reason: requiredString(record, 'reason'),
        evidenceHash: requiredString(record, 'evidenceHash'),
        timestamp: requiredTimestamp(record, 'timestamp'),
      };
  }
};

/**
 * Decode one raw chaincode event, or throw `EventDecodeError` describing
 * exactly what was wrong. Callers on the listener path use `tryDecodeEvent`.
 */
export const decodeEvent = (event: RawChaincodeEvent): IndexedEvent => {
  if (!isEventName(event.eventName)) {
    // Not corruption: another contract on the same chaincode is free to emit
    // events we do not index. The listener treats this as a skip, same as a
    // malformed payload, and the distinct message keeps the logs honest.
    throw new EventDecodeError(`unknown event name: ${event.eventName}`);
  }
  if (event.transactionId === '') {
    throw new EventDecodeError('event has no transaction id');
  }
  const payload = decodePayload(event.eventName, parseJsonObject(decodeUtf8(event.payload)));
  return {
    ...payload,
    blockNumber: toBlockNumber(event.blockNumber),
    transactionId: event.transactionId,
    chaincodeName: event.chaincodeName,
  };
};

/**
 * Non-throwing wrapper used by the listener. A bad payload must never take the
 * subscription down — one malformed event would otherwise cost us every event
 * after it, which is a far worse failure than losing the bad one.
 */
export const tryDecodeEvent = (
  event: RawChaincodeEvent,
  onSkip: (reason: string) => void = () => undefined,
): IndexedEvent | undefined => {
  try {
    return decodeEvent(event);
  } catch (error: unknown) {
    const blockLabel = ((): string => {
      try {
        return event.blockNumber.toString();
      } catch {
        return '?';
      }
    })();
    onSkip(
      `skipped event "${event.eventName}" in block ${blockLabel} tx ${event.transactionId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
};

/** Stable identity of an event, used to make replay after a crash idempotent. */
export const eventKey = (event: IndexedEvent): string =>
  `${String(event.blockNumber)}:${event.transactionId}:${event.eventName}`;
