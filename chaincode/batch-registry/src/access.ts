import { Context } from 'fabric-contract-api';

export const ROLE_ATTRIBUTE = 'role';

export enum Role {
  Producer = 'producer',
  Transporter = 'transporter',
  Warehouse = 'warehouse',
  Retailer = 'retailer',
  Regulator = 'regulator',
}

export const callerMsp = (ctx: Context): string => ctx.clientIdentity.getMSPID();

/**
 * Assert the caller carries the given role attribute on its enrolment
 * certificate.
 *
 * Roles are issued by Fabric CA as an ABAC attribute (`--id.attrs
 * 'role=producer:ecert'`), so the claim travels inside the signed certificate
 * and cannot be forged — unlike a role passed as a transaction argument, which
 * the caller controls entirely.
 */
export const assertRole = (ctx: Context, role: Role): void => {
  const actual = ctx.clientIdentity.getAttributeValue(ROLE_ATTRIBUTE);

  if (actual === null) {
    throw new Error(
      `access denied: caller certificate carries no '${ROLE_ATTRIBUTE}' attribute, ` +
        `'${role}' is required`,
    );
  }

  if (actual !== role) {
    throw new Error(`access denied: caller has role '${actual}', '${role}' is required`);
  }
};

/** True when the caller holds the given role, without throwing. */
export const hasRole = (ctx: Context, role: Role): boolean =>
  ctx.clientIdentity.getAttributeValue(ROLE_ATTRIBUTE) === role;
