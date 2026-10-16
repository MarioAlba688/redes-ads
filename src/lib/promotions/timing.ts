// Guía de cuándo conviene pagar publicidad en Colombia: fechas fuertes de compra y días de la semana según el cliente.
// Lógica pura (fechas AAAA-MM-DD, sin reloj ni datos de la cuenta): quien la usa pasa «hoy» en la zona de la app.

export type SalesDate = { date: string; label: string; note: string };

const DAY_MS = 86_400_000;
const utc = (date: string) => new Date(`${date}T00:00:00.000Z`);
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const weekday = (date: string) => utc(date).getUTCDay(); // 0 = domingo
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const plusDays = (date: string, n: number) => new Date(utc(date).getTime() + n * DAY_MS).toISOString().slice(0, 10);

/** El n-ésimo (1, 2, 3…) día de la semana `dow` (0 = domingo … 6 = sábado) de un mes. */
function nthWeekday(y: number, m: number, dow: number, n: number): string {
  const offset = (dow - weekday(ymd(y, m, 1)) + 7) % 7;
  return ymd(y, m, 1 + offset + (n - 1) * 7);
}

/** Un pago que cae en fin de semana se adelanta al viernes. */
function payDate(y: number, m: number, d: number): string {
  const date = ymd(y, m, Math.min(d, daysInMonth(y, m)));
  const w = weekday(date);
  return w === 6 ? plusDays(date, -1) : w === 0 ? plusDays(date, -2) : date;
}

/** Las próximas fechas de pago de quincena (el 15 y el 30, o el último día de febrero), desde `today` inclusive. */
export function upcomingPaydays(today: string, count: number): SalesDate[] {
  const [y, m] = today.split("-").map(Number);
  const found: SalesDate[] = [];
  for (let i = 0; i < 4; i++) {
    const year = y + Math.floor((m - 1 + i) / 12);
    const month = ((m - 1 + i) % 12) + 1;
    for (const day of [15, 30]) {
      const date = payDate(year, month, day);
      if (date >= today) found.push({ date, label: "Quincena", note: "Cada empresa paga distinto: cuenta los 2 o 3 días alrededor." });
    }
  }
  return found.sort((a, b) => a.date.localeCompare(b.date)).slice(0, count);
}

/** Las próximas fechas comerciales fuertes de Colombia (regalos, ofertas, primas), desde `today` inclusive. */
export function upcomingEvents(today: string, count: number): SalesDate[] {
  const y = Number(today.slice(0, 4));
  const found: SalesDate[] = [];
  for (const year of [y, y + 1]) {
    const thanksgiving = nthWeekday(year, 11, 4, 4); // cuarto jueves de noviembre (EE. UU.)
    found.push(
      { date: nthWeekday(year, 5, 0, 2), label: "Día de la Madre", note: "Una de las fechas más fuertes para regalos y cosméticos: empieza a anunciar 1 o 2 semanas antes." },
      { date: nthWeekday(year, 6, 0, 3), label: "Día del Padre", note: "Fuerte para regalos: empieza una semana antes." },
      { date: payDate(year, 6, 30), label: "Prima de junio", note: "Pago de la prima de servicios: la gente tiene más para gastar en los días siguientes." },
      { date: nthWeekday(year, 9, 6, 3), label: "Amor y Amistad", note: "Fecha de regalos: anuncia desde la semana anterior." },
      { date: plusDays(thanksgiving, 1), label: "Black Friday", note: "Mucha competencia por los anuncios: suele subir el costo. Anuncia solo ofertas claras." },
      { date: plusDays(thanksgiving, 4), label: "Cyber Lunes", note: "El segundo empujón de ofertas de la misma semana." },
      { date: payDate(year, 12, 20), label: "Prima de diciembre", note: "Pago de la prima de servicios, justo antes de Navidad: de las mejores fechas para vender." },
    );
  }
  return found.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, count);
}

/** «viernes 30 de octubre» (el día de la semana va primero para que se vea qué día cae). */
export function formatSalesDate(date: string): string {
  return new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(utc(date));
}

/** Qué días de la semana suelen rendir mejor según a quién se le vende. Regla general, no datos de la cuenta. */
export const AUDIENCE_TIPS: { who: string; best: string; weak: string }[] = [
  { who: "Le vendes a consumidor final (por ejemplo cosméticos)", best: "de jueves a domingo, sobre todo en la noche", weak: "de lunes a miércoles suele rendir menos" },
  { who: "Le vendes a empresas o negocios", best: "de martes a jueves, en horario de oficina", weak: "los fines de semana suele rendir poco" },
];
