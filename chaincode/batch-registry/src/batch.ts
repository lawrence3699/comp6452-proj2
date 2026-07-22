export enum BatchStatus {
  Created = 'CREATED',
  InTransit = 'IN_TRANSIT',
  AtWarehouse = 'AT_WAREHOUSE',
  Delivered = 'DELIVERED',
  Flagged = 'FLAGGED',
  Recalled = 'RECALLED',
}

export interface Batch {
  readonly batchId: string;
  readonly foodType: string;
  readonly producedAt: number;
  readonly shelfLifeDays: number;
  readonly origin: string;
  readonly quantity: number;
  readonly status: BatchStatus;
  readonly currentHolder: string;
  readonly reportHash: string;
}

export const withStatus = (batch: Batch, status: BatchStatus): Batch => ({
  ...batch,
  status,
});

export const withHolder = (batch: Batch, currentHolder: string): Batch => ({
  ...batch,
  currentHolder,
});
