export const MONEY_AMOUNT_PATTERN = "^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,2})?$";

const moneyAmountPattern = new RegExp(MONEY_AMOUNT_PATTERN);
const zeroAmountPattern = /^0(?:\.0{1,2})?$/;

export function isPositiveMoneyAmount(value: string): boolean {
  return moneyAmountPattern.test(value) && !zeroAmountPattern.test(value);
}

// Exact decimal arithmetic for amounts with up to two decimal places, shared by every module that
// adds or compares money, so the rounding rules never diverge.
export function moneyToCents(value: string): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -cents : cents;
}

export function moneyFromCents(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}
