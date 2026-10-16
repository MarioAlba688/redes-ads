import { addDays } from "@/lib/meta/dates";

// Tope de gasto MENSUAL de una cuenta publicitaria. Logica pura (fechas AAAA-MM-DD en la zona horaria de la cuenta).
//
// Al activar un anuncio se proyecta, para cada mes calendario que ese anuncio toca:
//   gastado en el mes (lo que Meta ya reporto)  +  lo que otros anuncios ACTIVOS de la app todavia pueden gastar en el
//   mes  +  lo que este anuncio puede gastar en el mes  <=  tope mensual.
// Es una proyeccion del MAXIMO posible (presupuesto diario x dias restantes): Meta puede gastar menos y, algun dia,
// hasta un 25 % mas, pero en una semana no pasa de 7 veces el diario. Lo gastado viene del rendimiento descargado de
// Meta, que puede llevar unas horas de retraso: por eso ademas existe el freno automatico que pausa al llegar al tope.

export type ActiveRun = {
  dailyBudget: number;
  /** Ultimo dia (inclusive) en que seguira gastando, o null si no se conoce (se cuenta hasta fin de mes). */
  endsOn: string | null;
};

export type Candidate = { dailyBudget: number; days: number };

export type MonthProjection = {
  /** AAAA-MM */
  month: string;
  spent: number;
  committed: number;
  candidate: number;
  total: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export const monthOf = (day: string) => day.slice(0, 7);

/** Primer dia (AAAA-MM-01) del mes de esa fecha. */
export const firstOfMonth = (day: string) => `${monthOf(day)}-01`;

/** Ultimo dia del mes de esa fecha. */
export function lastOfMonth(day: string): string {
  const first = firstOfMonth(day);
  const nextFirst = addDays(addDays(first, 31).slice(0, 8) + "01", 0);
  return addDays(nextFirst, -1);
}

/** Dias que hay entre dos fechas, ambas incluidas; 0 si `to` es anterior a `from`. */
export function daysInclusive(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return ms < 0 ? 0 : Math.round(ms / 86_400_000) + 1;
}

const minDay = (a: string, b: string) => (a < b ? a : b);
const maxDay = (a: string, b: string) => (a > b ? a : b);

/** Dias que quedan del mes contando hoy. */
export const daysLeftInMonth = (today: string) => daysInclusive(today, lastOfMonth(today));

/**
 * Proyeccion por cada mes que toca el candidato (el anuncio que se quiere activar, que empieza hoy y dura `days` dias):
 * normalmente uno, dos si cruza el fin de mes. Lo gastado solo existe para el mes en curso.
 */
export function projectMonthly(p: { today: string; spentThisMonth: number; active: readonly ActiveRun[]; candidate: Candidate }): MonthProjection[] {
  const candEnd = addDays(p.today, Math.max(p.candidate.days, 1) - 1);
  const months: MonthProjection[] = [];
  let cursor = firstOfMonth(p.today);
  while (cursor <= candEnd) {
    const start = maxDay(p.today, cursor);
    const end = lastOfMonth(cursor);
    const candidateDays = daysInclusive(start, minDay(candEnd, end));
    let committed = 0;
    for (const run of p.active) {
      committed += run.dailyBudget * daysInclusive(start, minDay(run.endsOn ?? end, end));
    }
    const spent = cursor === firstOfMonth(p.today) ? p.spentThisMonth : 0;
    const candidate = p.candidate.dailyBudget * candidateDays;
    months.push({ month: monthOf(cursor), spent: round2(spent), committed: round2(committed), candidate: round2(candidate), total: round2(spent + committed + candidate) });
    cursor = addDays(end, 1);
  }
  return months;
}

const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export const monthLabel = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month} de ${month.slice(0, 4)}`;

const num = (v: number, currency: string) => `${new Intl.NumberFormat("es", { maximumFractionDigits: 2 }).format(v)} ${currency}`;

/** Mensaje si algun mes proyectado pasa del tope mensual, o null si todo cabe. */
export function monthlyCapError(months: readonly MonthProjection[], cap: number, currency: string): string | null {
  const bad = months.find((m) => m.total > cap);
  if (!bad) return null;
  const parts = [
    bad.spent > 0 ? `ya se gastaron ${num(bad.spent, currency)}` : null,
    bad.committed > 0 ? `otros anuncios activos pueden gastar hasta ${num(bad.committed, currency)}` : null,
    `este anuncio puede gastar hasta ${num(bad.candidate, currency)}`,
  ].filter(Boolean);
  return `Superaría el tope mensual de la cuenta (${num(cap, currency)}): en ${monthLabel(bad.month)} ${parts.join(", ")}; en total hasta ${num(bad.total, currency)}. Baja el presupuesto o la duración, pausa otro anuncio o pídele al administrador que suba el tope mensual.`;
}
