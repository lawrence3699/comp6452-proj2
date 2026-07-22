/**
 * Off-chain storage adapter — owner: person 3.
 *
 * Inspection reports, photographs and raw sensor series live here. Only the
 * returned hash is anchored on chain.
 */

export interface StoredObject {
  readonly hash: string;
  readonly location: string;
}

// TODO(person 3): write to IPFS or a cloud bucket, return the content hash.
export const put = async (_payload: Buffer, _contentType: string): Promise<StoredObject> => {
  throw new Error('not implemented');
};

// TODO(person 3): fetch by hash and verify the content matches it before
// returning, so a tampered object is detected.
export const get = async (_hash: string): Promise<Buffer> => {
  throw new Error('not implemented');
};
