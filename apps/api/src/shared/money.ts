export const MONEY_AMOUNT_PATTERN = "^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,2})?$";

const moneyAmountPattern = new RegExp(MONEY_AMOUNT_PATTERN);
const zeroAmountPattern = /^0(?:\.0{1,2})?$/;

export function isPositiveMoneyAmount(value: string): boolean {
  return moneyAmountPattern.test(value) && !zeroAmountPattern.test(value);
}
