import { AUDIENCE_TIPS, formatSalesDate, upcomingEvents, upcomingPaydays } from "@/lib/promotions/timing";

/**
 * Recomendaciones de cuándo conviene activar un anuncio. Es la misma pieza en Crear anuncio y en el Manual.
 * `today` (AAAA-MM-DD, en la zona de la app) lo pasa quien la dibuja: así las fechas próximas nunca quedan viejas.
 */
export function TimingAdvice({ today }: { today: string }) {
  const paydays = upcomingPaydays(today, 2);
  const events = upcomingEvents(today, 3);
  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="font-medium">Según a quién le vendes</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {AUDIENCE_TIPS.map((t) => (
            <li key={t.who}>
              {t.who}: <strong className="font-semibold">{t.best}</strong>; {t.weak}.
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="font-medium">Fechas con más ganas de comprar (Colombia)</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {paydays.map((p) => (
            <li key={p.date}>
              <strong className="font-semibold">{formatSalesDate(p.date)}</strong>: {p.label}. {p.note}
            </li>
          ))}
          {events.map((e) => (
            <li key={e.date + e.label}>
              <strong className="font-semibold">{formatSalesDate(e.date)}</strong>: {e.label}. {e.note}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="font-medium">Con poco presupuesto</p>
        <p className="mt-1">
          Con un presupuesto diario muy bajo (menos de un dólar al día) Meta entrega poco y no se nota qué día va mejor. Suele convenir juntar el dinero en una racha corta de 3 o 4 días en una fecha fuerte, y no repartirlo poco a poco todos los días (el administrador sube el tope diario en Cuentas).
        </p>
      </div>
      <div>
        <p className="font-medium">Cómo programarlo aquí</p>
        <p className="mt-1">
          La duración empieza a contar cuando se <strong className="font-semibold">activa</strong> el anuncio y la app no tiene horarios por día de la semana. Crea el anuncio con los días que quieres que corra (queda en pausa) y pide que quien aprueba lo active la noche anterior a la fecha: Meta revisa el anuncio antes de mostrarlo y puede tardar horas.
        </p>
      </div>
      <div>
        <p className="font-medium">Después de 2 o 3 semanas</p>
        <p className="mt-1">Mira en Anuncios el gasto y el costo por resultado de cada día. Si un día sale claramente más barato, ahí pon más inversión. No decidas con un solo día.</p>
      </div>
    </div>
  );
}
