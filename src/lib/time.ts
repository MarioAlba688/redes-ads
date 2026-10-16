// Conversion entre la hora "de pared" de una zona horaria (la que escribe la persona al programar) y UTC
// (lo que se guarda). Sin librerias: solo Intl, que ya conoce los horarios de verano de cada zona.

/** Desfase de la zona respecto a UTC en un instante, en minutos (Bogota: -300). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * "2026-10-16T09:00" en `timeZone` -> el instante UTC correspondiente. Devuelve null si el texto no tiene
 * ese formato, la fecha no existe o la hora no existe en esa zona (el salto de horario de verano se la "come").
 * Si la hora ocurre dos veces (cuando se atrasa el reloj) se toma la primera.
 */
export function zonedTimeToUtc(local: string, timeZone: string): Date | null {
  const m = LOCAL_RE.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // La fecha tiene que existir (no 31 de febrero ni 25:00).
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h) return null;

  try {
    // El desfase depende del instante, y el instante del desfase: se afina en dos pasadas.
    let utc = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000;
    utc = naive - zoneOffsetMinutes(new Date(utc), timeZone) * 60_000;
    const result = new Date(utc);
    // Si al volver a la zona no da la misma hora, esa hora no existe (salto de verano).
    return formatLocalInput(result, timeZone) === local ? result : null;
  } catch {
    return null; // zona horaria desconocida
  }
}

/** Instante UTC -> "2026-10-16T09:00" en la zona (formato de <input type="datetime-local">). */
export function formatLocalInput(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
