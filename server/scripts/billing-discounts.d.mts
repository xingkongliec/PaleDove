export function backfillBillingDiscounts(db: {
  exec(sql: string): unknown;
  transaction<T>(callback: () => T): () => T;
}): void;
