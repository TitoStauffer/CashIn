import type { ParsedFinancialImportItem } from "./financial-imports.types.js";

// Helpers shared by the repository and the modules split out of it: batching, the date and timestamp
// shapes PostgreSQL returns, and the one way an item is invalidated when a reference does not hold.

// A statement may bring up to 10,000 lines, so every write that fans out over the items goes in
// batches instead of one statement per line.
export const IMPORT_BATCH_SIZE = 500;

export function chunks<Item>(items: Item[], size = IMPORT_BATCH_SIZE): Item[][] {
  const result: Item[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

// node-postgres returns a date column as a Date or as a string depending on the driver's settings,
// and both shapes reach these modules.
export function dateValue(value: string | Date | null): string {
  if (value === null) return "";
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

export function timestampValue(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// A reference that does not exist in the wallet invalidates the item, keeping a duplicate a duplicate
// and preserving whatever message the parser had already written.
export function invalidateReference(
  item: ParsedFinancialImportItem,
  message: string,
  categoryId: string | null,
): ParsedFinancialImportItem {
  const currentMessage = item.errorMessage?.trim();
  const isDuplicate = item.validationStatus === "duplicate";
  return {
    ...item,
    categoryId,
    subcategoryId: null,
    categorizationSource: null,
    validationStatus: isDuplicate ? "duplicate" : "invalid",
    errorMessage: currentMessage ? `${currentMessage} ${message}` : message,
    isRepairable: isDuplicate ? false : item.validationStatus === "invalid" ? item.isRepairable === true : true,
  };
}
