import "server-only";
import { env } from "@/lib/env";

/**
 * Formateador de fechas para las pantallas, en la zona horaria de la app (APP_TIMEZONE) y no en la del servidor.
 * Para la hora de una publicacion programada se usa la zona de su marca (ver lib/time.ts).
 */
export function dateTimeFormat(opts: { time?: boolean; timeZone?: string } = {}): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("es", {
    dateStyle: "medium",
    ...(opts.time === false ? {} : { timeStyle: "short" as const }),
    timeZone: opts.timeZone ?? env().APP_TIMEZONE,
  });
}
