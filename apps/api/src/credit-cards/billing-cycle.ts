export interface BillingCycle {
  closingDate: string;
  dueDate: string;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function dateForDay(year: number, month: number, day: number): string {
  const boundedDay = Math.min(day, daysInMonth(year, month));
  return new Date(Date.UTC(year, month, boundedDay)).toISOString().slice(0, 10);
}

export function calculateBillingCycle(
  purchaseDate: string,
  closingDay: number,
  dueDay: number,
): BillingCycle {
  const [year, month, day] = purchaseDate.split("-").map(Number);
  const monthIndex = month - 1;
  const currentClosingDate = dateForDay(year, monthIndex, closingDay);
  const closesThisMonth = purchaseDate <= currentClosingDate;
  const closingMonth = closesThisMonth ? monthIndex : monthIndex + 1;
  const closingYear = year + Math.floor(closingMonth / 12);
  const normalizedClosingMonth = closingMonth % 12;
  const closingDate = dateForDay(closingYear, normalizedClosingMonth, closingDay);

  const dueMonth = dueDay > closingDay ? normalizedClosingMonth : normalizedClosingMonth + 1;
  const dueYear = closingYear + Math.floor(dueMonth / 12);
  const normalizedDueMonth = dueMonth % 12;

  return {
    closingDate,
    dueDate: dateForDay(dueYear, normalizedDueMonth, dueDay),
  };
}
