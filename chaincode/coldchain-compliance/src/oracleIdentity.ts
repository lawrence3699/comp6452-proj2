import { Context } from 'fabric-contract-api';

export const ORACLE_ATTRIBUTE = 'oracle';
export const ROLE_ATTRIBUTE = 'role';
export const REGULATOR_ROLE = 'regulator';

/**
 * Only identities carrying the oracle attribute may submit readings.
 *
 * The attribute is baked into the enrolment certificate by Fabric CA
 * (`--id.attrs 'oracle=true:ecert'`), so it is signed by the CA and cannot be
 * spoofed by a client crafting its own arguments.
 */
export const assertOracle = (ctx: Context): void => {
  const value = ctx.clientIdentity.getAttributeValue(ORACLE_ATTRIBUTE);

  if (value !== 'true') {
    throw new Error(
      'access denied: only an identity enrolled with the oracle attribute may ' +
        'submit temperature readings',
    );
  }
};

/** Regulators act on the manual path, independent of the oracle. */
export const assertRegulator = (ctx: Context): void => {
  const role = ctx.clientIdentity.getAttributeValue(ROLE_ATTRIBUTE);

  if (role !== REGULATOR_ROLE) {
    throw new Error(`access denied: caller role '${role ?? 'none'}' is not a regulator`);
  }
};
