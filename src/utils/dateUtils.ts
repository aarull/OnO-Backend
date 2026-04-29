const IST_TIMEZONE = 'Asia/Kolkata' as const;

/**
 * Returns the current instant as a Date object.
 * Note: Date is always an absolute instant; timezone matters only when formatting.
 */
export function getNow(): Date {
  return new Date();
}

export function formatIstToDDMMYY(d: Date = getNow()): string {
  // "en-IN" typically emits DD/MM/YY; convert to DD-MM-YY
  return d
    .toLocaleDateString('en-IN', {
      timeZone: IST_TIMEZONE,
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    })
    .replace(/\//g, '-');
}

export function formatIstToMonthYear(d: Date = getNow()): string {
  // e.g. "Apr-26"
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIMEZONE,
    month: 'short',
    year: '2-digit',
  }).formatToParts(d);

  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  return `${month}-${year}`;
}

export function getIstYear(d: Date = getNow()): number {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value;
  const n = year ? Number(year) : NaN;
  return Number.isFinite(n) ? n : d.getUTCFullYear();
}

