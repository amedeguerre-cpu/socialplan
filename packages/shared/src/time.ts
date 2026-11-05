/** Saat yardımcıları — tüm DB zamanları UTC ISO; slotlar marka saat diliminde 'HH:MM'. */

export const DEFAULT_TZ = 'Europe/Istanbul';

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO: Pazartesi=1 … Pazar=7 */
  weekday: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export type DateInput = Date | number | string;

export function zonedParts(date: DateInput, tz: string): ZonedParts {
  const parts = fmt(tz).formatToParts(date instanceof Date ? date : new Date(date));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WD[get('weekday')] ?? 1,
  };
}

function offsetMs(utcMs: number, tz: string): number {
  const p = zonedParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** 'YYYY-MM-DD' + 'HH:MM' (tz yerel) → UTC Date. DST boşluğunda ileri kayar. */
export function zonedToUtc(ymd: string, hm: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const guess = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  let ts = guess - offsetMs(guess, tz);
  const off2 = offsetMs(ts, tz);
  ts = guess - off2;
  return new Date(ts);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** UTC an → tz'de 'YYYY-MM-DD' */
export function ymdInTz(date: DateInput, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** UTC an → tz'de 'HH:MM' */
export function hmInTz(date: DateInput, tz: string): string {
  const p = zonedParts(date, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** ISO hafta günü (Pzt=1) — takvim tarihinden (tz bağımsız). */
export function weekdayOfYmd(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** tz'deki haftanın pazartesisi ('YYYY-MM-DD'). */
export function weekStartYmd(date: DateInput, tz: string): string {
  const ymd = ymdInTz(date, tz);
  return addDaysYmd(ymd, 1 - weekdayOfYmd(ymd));
}

/** YouTube kota günü: Pasifik saatine göre 'YYYY-MM-DD'. */
export function pacificDay(date: DateInput): string {
  return ymdInTz(date, 'America/Los_Angeles');
}

export function isValidHm(hm: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(hm);
}

export function formatTr(date: Date | number | string, tz: string = DEFAULT_TZ): string {
  const d = typeof date === 'string' ? new Date(date) : new Date(date);
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}
