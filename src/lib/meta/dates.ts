/** Fecha de hoy (AAAA-MM-DD) en una zona horaria; si la zona no es valida, en UTC. */
export function todayInTimezone(timeZone: string | null | undefined, now = new Date()): string {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  try {
    return format(timeZone || "UTC");
  } catch {
    return format("UTC");
  }
}

/** Suma (o resta) dias a una fecha AAAA-MM-DD. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** AAAA-MM-DD -> Date a medianoche UTC, que es como MySQL guarda una columna DATE con Prisma. */
export function toDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function fromDbDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
