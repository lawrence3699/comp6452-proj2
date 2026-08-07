import { expect } from 'chai';
import { ChaincodeEvent, Checkpointer } from '@hyperledger/fabric-gateway';
import { RawChaincodeEvent } from '../src/events';
import { checkpointFile, consumeEvents, defaultCheckpointFile } from '../src/listen';
import { MemoryEventStore } from '../src/store';

/**
 * `consumeEvents` is the whole listener loop minus the gRPC connection, so it
 * is driven here with a fabricated async iterable and an in-memory
 * checkpointer that records what it was told. No network, no peer.
 */
const raw = (
  eventName: string,
  payload: unknown,
  overrides: Partial<RawChaincodeEvent> = {},
): ChaincodeEvent =>
  ({
    blockNumber: 5n,
    transactionId: 'tx-5',
    chaincodeName: 'batch-registry',
    eventName,
    payload: new TextEncoder().encode(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    ),
    ...overrides,
  }) as ChaincodeEvent;

const registered = (batchId: string, block: number): ChaincodeEvent =>
  raw(
    'BatchRegistered',
    { batchId, producer: 'producer1', timestamp: 1_700_000_000 + block },
    { blockNumber: BigInt(block), transactionId: `tx-${String(block)}` },
  );

async function* stream(events: readonly ChaincodeEvent[]): AsyncIterable<ChaincodeEvent> {
  for (const event of events) {
    yield event;
  }
}

/** Records every checkpoint call so the tests can assert on progress tracking. */
class RecordingCheckpointer implements Checkpointer {
  readonly checkpointed: ChaincodeEvent[] = [];
  #blockNumber: bigint | undefined;
  #transactionId: string | undefined;

  getBlockNumber = (): bigint | undefined => this.#blockNumber;
  getTransactionId = (): string | undefined => this.#transactionId;

  checkpointBlock = async (blockNumber: bigint): Promise<void> => {
    this.#blockNumber = blockNumber + 1n;
    this.#transactionId = undefined;
  };

  checkpointTransaction = async (blockNumber: bigint, transactionId: string): Promise<void> => {
    this.#blockNumber = blockNumber;
    this.#transactionId = transactionId;
  };

  checkpointChaincodeEvent = async (event: ChaincodeEvent): Promise<void> => {
    this.checkpointed.push(event);
    await this.checkpointTransaction(event.blockNumber, event.transactionId);
  };
}

describe('checkpoint file resolution', () => {
  const REGISTRY = 'batch-registry';
  const COMPLIANCE = 'coldchain-compliance';
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.INDEXER_CHECKPOINT_FILE;
    delete process.env.INDEXER_CHECKPOINT_FILE;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.INDEXER_CHECKPOINT_FILE;
    } else {
      process.env.INDEXER_CHECKPOINT_FILE = savedEnv;
    }
  });

  it('derives a distinct default per chaincode so two streams never share state', () => {
    const registry = checkpointFile(REGISTRY, REGISTRY);
    const compliance = checkpointFile(COMPLIANCE, REGISTRY);

    expect(registry).to.not.equal(compliance);
    expect(registry).to.equal(defaultCheckpointFile(REGISTRY));
    expect(compliance).to.equal(defaultCheckpointFile(COMPLIANCE));
    expect(registry).to.match(/checkpoint-batch-registry\.json$/);
    expect(compliance).to.match(/checkpoint-coldchain-compliance\.json$/);
  });

  it('lets INDEXER_CHECKPOINT_FILE override the registry stream only (back-compat)', () => {
    process.env.INDEXER_CHECKPOINT_FILE = '/tmp/registry-checkpoint.json';

    expect(checkpointFile(REGISTRY, REGISTRY)).to.equal('/tmp/registry-checkpoint.json');
    // Honouring the env var for the compliance stream would recreate the
    // shared-file hazard the per-chaincode default exists to prevent.
    expect(checkpointFile(COMPLIANCE, REGISTRY)).to.equal(defaultCheckpointFile(COMPLIANCE));
  });

  it('ignores an empty INDEXER_CHECKPOINT_FILE', () => {
    process.env.INDEXER_CHECKPOINT_FILE = '';

    expect(checkpointFile(REGISTRY, REGISTRY)).to.equal(defaultCheckpointFile(REGISTRY));
  });
});

describe('event consumption', () => {
  it('indexes every well-formed event and checkpoints each one', async () => {
    const store = new MemoryEventStore();
    const checkpointer = new RecordingCheckpointer();

    const result = await consumeEvents(
      stream([registered('BATCH-1', 3), registered('BATCH-2', 4)]),
      store,
      checkpointer,
    );

    expect(result).to.deep.equal({ indexed: 2, duplicates: 0, skipped: 0 });
    expect(store.size()).to.equal(2);
    expect(checkpointer.checkpointed).to.have.lengthOf(2);
    expect(checkpointer.getBlockNumber()).to.equal(4n);
    expect(checkpointer.getTransactionId()).to.equal('tx-4');
  });

  it('logs and skips a malformed payload without stopping the stream', async () => {
    const store = new MemoryEventStore();
    const checkpointer = new RecordingCheckpointer();
    const skips: string[] = [];

    const result = await consumeEvents(
      stream([
        registered('BATCH-1', 3),
        raw('BatchRegistered', 'not json', { blockNumber: 4n, transactionId: 'tx-4' }),
        registered('BATCH-2', 5),
      ]),
      store,
      checkpointer,
      { onSkip: (reason) => skips.push(reason) },
    );

    // The event after the bad one is what matters: a throw would have cost it.
    expect(result).to.deep.equal({ indexed: 2, duplicates: 0, skipped: 1 });
    expect(store.batchIds()).to.have.members(['BATCH-1', 'BATCH-2']);
    expect(skips).to.have.lengthOf(1);
    expect(skips[0]).to.match(/payload is not JSON/);
  });

  it('checkpoints past a malformed event so a restart does not wedge on it', async () => {
    const store = new MemoryEventStore();
    const checkpointer = new RecordingCheckpointer();

    await consumeEvents(
      stream([raw('BatchRegistered', '{{{', { blockNumber: 9n, transactionId: 'tx-9' })]),
      store,
      checkpointer,
      { onSkip: () => undefined },
    );

    expect(checkpointer.checkpointed).to.have.lengthOf(1);
    expect(checkpointer.getTransactionId()).to.equal('tx-9');
  });

  it('skips an event from a contract we do not index', async () => {
    const store = new MemoryEventStore();
    const skips: string[] = [];

    const result = await consumeEvents(
      stream([raw('TemperatureRecorded', { batchId: 'BATCH-1' })]),
      store,
      new RecordingCheckpointer(),
      { onSkip: (reason) => skips.push(reason) },
    );

    expect(result.skipped).to.equal(1);
    expect(skips[0]).to.match(/unknown event name: TemperatureRecorded/);
  });

  it('counts a redelivered event as a duplicate rather than indexing it twice', async () => {
    // Exactly what a checkpointed restart produces: the block containing the
    // last processed transaction is delivered again.
    const store = new MemoryEventStore();
    const replayed = registered('BATCH-1', 3);

    const result = await consumeEvents(
      stream([replayed, replayed]),
      store,
      new RecordingCheckpointer(),
    );

    expect(result).to.deep.equal({ indexed: 1, duplicates: 1, skipped: 0 });
    expect(store.size()).to.equal(1);
  });

  it('stops at maxEvents', async () => {
    const store = new MemoryEventStore();

    const result = await consumeEvents(
      stream([registered('B1', 1), registered('B2', 2), registered('B3', 3)]),
      store,
      new RecordingCheckpointer(),
      { maxEvents: 2 },
    );

    expect(result.indexed).to.equal(2);
    expect(store.size()).to.equal(2);
  });

  it('stops when the caller aborts', async () => {
    const store = new MemoryEventStore();
    const controller = new AbortController();

    const result = await consumeEvents(
      stream([registered('B1', 1), registered('B2', 2)]),
      store,
      new RecordingCheckpointer(),
      {
        signal: controller.signal,
        onEvent: () => controller.abort(),
      },
    );

    expect(result.indexed).to.equal(1);
  });

  it('reports the events it saw through onEvent', async () => {
    const seen: string[] = [];

    await consumeEvents(
      stream([registered('BATCH-1', 3)]),
      new MemoryEventStore(),
      new RecordingCheckpointer(),
      { onEvent: (event, isNew) => seen.push(`${event.batchId}:${String(isNew)}`) },
    );

    expect(seen).to.deep.equal(['BATCH-1:true']);
  });
});
