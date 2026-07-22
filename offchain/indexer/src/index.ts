/**
 * Chaincode event indexer — owner: person 3.
 *
 * Consumes BatchRegistered, CustodyTransferred and BatchFlagged, persists
 * them, and serves the fast traceability queries behind FR2 and NFR1.
 */

export type EventName = 'BatchRegistered' | 'CustodyTransferred' | 'BatchFlagged';

// TODO(person 3): subscribe with the Fabric gateway block or chaincode event
// listener and persist each event.
export const listen = async (): Promise<void> => {
  throw new Error('not implemented');
};

// TODO(person 3): serve the indexed history for one batch.
export const historyFor = async (_batchId: string): Promise<unknown[]> => {
  throw new Error('not implemented');
};
