import { Context } from 'fabric-contract-api';

export const ORACLE_ATTRIBUTE = 'oracle';

// TODO(person 2): only identities carrying the oracle attribute may submit
// readings. Reject everything else with a clear error.
export const assertOracle = (_ctx: Context): void => {
  throw new Error('not implemented');
};
