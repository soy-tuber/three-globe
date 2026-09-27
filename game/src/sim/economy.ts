// Company finances: cash plus a categorised daily ledger.

export type LedgerCategory = 'fare' | 'fuel' | 'toll' | 'crew' | 'fixed' | 'purchase';

export const CATEGORY_LABEL: Record<LedgerCategory, string> = {
  fare: '運賃収入',
  fuel: '燃料・整備',
  toll: '高速料金',
  crew: '乗務員人件費',
  fixed: '固定費',
  purchase: '車両購入',
};

export interface DailyReport {
  /** local day index (see clock.localDay) */
  day: number;
  income: Partial<Record<LedgerCategory, number>>;
  expense: Partial<Record<LedgerCategory, number>>;
  passengers: number;
  /** passengers who gave up waiting */
  lostPassengers: number;
  vehicleKm: number;
}

export interface CompanyState {
  name: string;
  cash: number;
  /** reports for completed days, oldest first (capped) */
  history: DailyReport[];
  today: DailyReport;
  totals: { passengers: number; revenue: number; expense: number };
}

export const HISTORY_DAYS = 60;

export function emptyReport(day: number): DailyReport {
  return { day, income: {}, expense: {}, passengers: 0, lostPassengers: 0, vehicleKm: 0 };
}

export function createCompany(name: string, cash: number, day: number): CompanyState {
  return { name, cash, history: [], today: emptyReport(day), totals: { passengers: 0, revenue: 0, expense: 0 } };
}

export function earn(c: CompanyState, cat: LedgerCategory, amount: number) {
  c.cash += amount;
  c.today.income[cat] = (c.today.income[cat] ?? 0) + amount;
  c.totals.revenue += amount;
}

export function spend(c: CompanyState, cat: LedgerCategory, amount: number) {
  c.cash -= amount;
  c.today.expense[cat] = (c.today.expense[cat] ?? 0) + amount;
  c.totals.expense += amount;
}

export const sum = (r: Partial<Record<LedgerCategory, number>>) => Object.values(r).reduce((a, b) => a + (b ?? 0), 0);

export function profit(r: DailyReport): number {
  return sum(r.income) - sum(r.expense);
}

/** Profit from operations only — excludes capital spending such as vehicle purchases. */
export function operatingProfit(r: DailyReport): number {
  return profit(r) + (r.expense.purchase ?? 0);
}

/** Close the books for the day and open a new report. */
export function rollDay(c: CompanyState, newDay: number): DailyReport {
  const closed = c.today;
  c.history.push(closed);
  if (c.history.length > HISTORY_DAYS) c.history.shift();
  c.today = emptyReport(newDay);
  return closed;
}
