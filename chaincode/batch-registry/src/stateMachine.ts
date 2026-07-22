import { BatchStatus } from './batch';

const TRANSITIONS: Readonly<Record<BatchStatus, readonly BatchStatus[]>> = {
  [BatchStatus.Created]: [BatchStatus.InTransit, BatchStatus.Flagged],
  [BatchStatus.InTransit]: [BatchStatus.AtWarehouse, BatchStatus.Flagged],
  [BatchStatus.AtWarehouse]: [BatchStatus.InTransit, BatchStatus.Delivered, BatchStatus.Flagged],
  [BatchStatus.Delivered]: [BatchStatus.Flagged],
  [BatchStatus.Flagged]: [BatchStatus.Recalled],
  [BatchStatus.Recalled]: [],
};

export const canTransition = (from: BatchStatus, to: BatchStatus): boolean =>
  TRANSITIONS[from].includes(to);

export const assertTransition = (from: BatchStatus, to: BatchStatus): void => {
  if (!canTransition(from, to)) {
    throw new Error(`illegal status transition: ${from} -> ${to}`);
  }
};
