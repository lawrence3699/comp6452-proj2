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

// TODO(person 1): assert the caller carries the given role attribute on its
// certificate, and throw a descriptive error when it does not.
export const assertRole = (_ctx: Context, _role: Role): void => {
  throw new Error('not implemented');
};
