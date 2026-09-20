import { AppError } from './errors';

export const QUALITY = ['Good Win', 'Bad Win', 'Good Loss', 'Bad Loss'] as const;
export const SESSIONS = ['Asia', 'London', 'London/NY', 'New York', 'Off-hours'] as const;
export const CURRENCIES = [
  'USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'CHF', 'JPY', 'SGD', 'HKD', 'CNY', 'INR', 'AED',
  'SAR', 'ZAR', 'NGN', 'KES', 'PKR', 'BDT', 'MXN', 'BRL', 'SEK', 'NOK', 'DKK', 'PLN', 'TRY', 'USDT',
] as const;

export const EXIT_REASONS = [
  'Target hit', 'Ran past target', 'Trailed stop hit', 'Stopped out', 'Manual close',
] as const;

/** Anything within 5% of the risk distance counts as "landed on" that level. */
const EXIT_TOLERANCE_R = 0.05;

/**
 * Works out how a trade ended from its prices alone, so the common case needs
 * no extra typing. Every distance is measured in R against the initial stop,
 * which makes it scale-free: it reads EURUSD and BTC the same way, and it
 * handles shorts without a special case because the risk distance is negative
 * for them.
 */
export function detectExitReason(o: {
  entry: number; sl: number; finalSl: number; tp: number | null; exit: number;
}): string {
  const risk = o.entry - o.sl;
  if (!risk) return 'Manual close';
  const r = (v: number) => (v - o.entry) / risk;
  const rExit = r(o.exit);

  if (o.tp !== null && Number.isFinite(o.tp)) {
    const rTp = r(o.tp);
    if (rExit >= rTp - EXIT_TOLERANCE_R) {
      return rExit > rTp + EXIT_TOLERANCE_R ? 'Ran past target' : 'Target hit';
    }
  }
  if (o.finalSl !== o.sl && Math.abs(rExit - r(o.finalSl)) <= EXIT_TOLERANCE_R) {
    return 'Trailed stop hit';
  }
  if (Math.abs(rExit + 1) <= EXIT_TOLERANCE_R) return 'Stopped out';
  return 'Manual close';
}

export const MAX_SHOTS = 4;
export const MAX_SHOT_BYTES = 4 * 1024 * 1024;

/** Trading sessions by UTC time (approximate - ignores daylight-saving shifts). */
export function sessionOf(d: Date): string {
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (h >= 23 || h < 7) return 'Asia';        // 23:00-07:00 UTC (Sydney + Tokyo)
  if (h < 12) return 'London';                // 07:00-12:00
  if (h < 16) return 'London/NY';             // 12:00-16:00 overlap
  if (h < 21) return 'New York';              // 16:00-21:00
  return 'Off-hours';                         // 21:00-23:00
}

/** Timezones are stored as a plain UTC/GMT offset, e.g. "UTC-05:00", "UTC+05:30", "UTC". */
export function offsetMin(tz: unknown): number | null {
  const m = /^UTC(?:([+-])(\d{2}):(\d{2}))?$/.exec(String(tz || ''));
  if (!m) return null;
  return m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

export function validTz(tz: unknown): string {
  const s = String(tz || '').trim().replace(/^GMT/i, 'UTC').replace(/^utc/, 'UTC');
  const o = offsetMin(s);
  return o !== null && o >= -720 && o <= 840 ? s : '';
}

export function validCcy(c: unknown): string {
  const s = String(c || '').trim().toUpperCase();
  return (CURRENCIES as readonly string[]).includes(s) ? s : '';
}

export function round(n: number, d: number): number {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

export function str(v: unknown, max = 2000): string {
  return String(v ?? '').slice(0, max);
}

export function num(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function isIsoDate(v: unknown): v is string {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

export function todayIn(tz: string): string {
  const off = offsetMin(tz) ?? 0;
  return new Date(Date.now() + off * 60000).toISOString().slice(0, 10);
}

/** 3-20 letters, numbers or underscore - same rule the original journal used. */
export function validUsername(name: unknown): string {
  const s = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(s)) {
    throw new AppError('Username: 3-20 letters, numbers or underscore.');
  }
  return s;
}

/** Turns a Postgres `date`/`timestamptz` column into what the UI expects. */
export function dateOnly(v: unknown): string {
  const s = String(v ?? '');
  return s.slice(0, 10);
}

export function isoOrEmpty(v: unknown): string {
  if (!v) return '';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** The UI prints "-" for `''` but "- USD" for null, so keep the empty string. */
export function orBlank(v: number | null | undefined): number | '' {
  return v === null || v === undefined ? '' : v;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres rejects a malformed uuid with a 500, so check before querying. */
export function uuid(v: unknown, what = 'record'): string {
  const s = String(v || '').trim();
  if (!UUID_RE.test(s)) throw new AppError(`That ${what} was not found.`, 404);
  return s;
}
