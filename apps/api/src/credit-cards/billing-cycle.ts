export interface BillingCycle {
  closingDate: string;
  dueDate: string;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

// month may be outside 0..11; it is normalized together with the year.
function dateForDay(year: number, month: number, day: number): string {
  const normalizedYear = year + Math.floor(month / 12);
  const normalizedMonth = ((month % 12) + 12) % 12;
  const boundedDay = Math.min(day, daysInMonth(normalizedYear, normalizedMonth));
  return new Date(Date.UTC(normalizedYear, normalizedMonth, boundedDay)).toISOString().slice(0, 10);
}

function splitDate(value: string): [number, number] {
  const [year, month] = value.split("-").map(Number);
  return [year!, month! - 1];
}

// The due date falls in the closing month when the due day comes after the closing day, otherwise
// in the following month.
export function calculateDueDate(closingDate: string, closingDay: number, dueDay: number): string {
  const [year, month] = splitDate(closingDate);
  return dateForDay(year, dueDay > closingDay ? month : month + 1, dueDay);
}

export function calculateBillingCycle(
  purchaseDate: string,
  closingDay: number,
  dueDay: number,
): BillingCycle {
  const [year, month] = splitDate(purchaseDate);
  const currentClosingDate = dateForDay(year, month, closingDay);
  const closingDate = purchaseDate <= currentClosingDate ? currentClosingDate : dateForDay(year, month + 1, closingDay);
  return { closingDate, dueDate: calculateDueDate(closingDate, closingDay, dueDay) };
}

// Statements a purchase may be moved to when the issuer posted it to a neighbouring cycle: the
// previous, the calculated and the next one.
export function adjacentClosingDates(purchaseDate: string, closingDay: number, dueDay: number): string[] {
  const [year, month] = splitDate(calculateBillingCycle(purchaseDate, closingDay, dueDay).closingDate);
  return [
    dateForDay(year, month - 1, closingDay),
    dateForDay(year, month, closingDay),
    dateForDay(year, month + 1, closingDay),
  ];
}
