import { Context } from 'fabric-contract-api';

export const ORACLE_ATTRIBUTE = 'oracle';

/**
 * Checks whether the current caller is an authorised oracle.
 */
export const assertOracle = (ctx: Context): void => {
  const oracleAttribute =
    ctx.clientIdentity.getAttributeValue(
      ORACLE_ATTRIBUTE,
    );

  if (oracleAttribute === null) {
    throw new Error(
      "access denied: caller certificate carries no 'oracle' attribute",
    );
  }

  if (oracleAttribute !== 'true') {
    throw new Error(
      "access denied: caller certificate must carry 'oracle=true'",
    );
  }
};
