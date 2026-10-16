import { formatMoney } from "@/lib/format";

// Que corregir cuando un anuncio no se pudo crear, segun lo que dijo el error. Logica pura (texto -> consejos).

export type FailureContext = { dailyCap: number | null; currency: string };

/**
 * Consejos en español para quien va a crear de nuevo un anuncio que fallo. Reconoce los fallos que se pueden corregir
 * desde la app; si no reconoce ninguno devuelve una lista vacia (el mensaje de error ya trae el detalle de Meta).
 */
export function failureHints(error: string | null | undefined, ctx: FailureContext): string[] {
  if (!error) return [];
  const hints: string[] = [];
  const money = (v: number) => formatMoney(v, ctx.currency);

  if (/No se encontró el archivo de la imagen/i.test(error)) {
    hints.push("Primero restaura la imagen: abre la publicación en Publicaciones y vuelve a subir la imagen original (o elige otra publicación que tenga imagen).");
  }
  if (/presupuesto/i.test(error) && /mínimo|minimo|más de|mas de|too low|minimum|more than/i.test(error)) {
    hints.push(
      ctx.dailyCap !== null
        ? `Sube el presupuesto diario por encima del mínimo que dice Meta, sin pasar del tope diario de la cuenta (${money(ctx.dailyCap)}). Si el mínimo de Meta es mayor que el tope, pídele al administrador que suba el tope en Cuentas.`
        : "Sube el presupuesto diario por encima del mínimo que dice Meta (y pídele al administrador que fije el tope diario de la cuenta en Cuentas).",
    );
  }
  if (/modo de desarrollo/i.test(error)) {
    hints.push("Pasa tu app de Meta a modo Publicado (Live) en developers.facebook.com (Manual, sección 8, paso «La app de Meta en modo Publicado») y luego pulsa «Crear de nuevo». Si Meta sigue rechazándolo, pulsa «Reconectar Meta» en Cuentas.");
  }
  if (/método de pago/i.test(error)) hints.push("Agrega o corrige el método de pago de la cuenta publicitaria en Meta (Manual, sección 8) y vuelve a intentarlo.");
  if (/términos/i.test(error)) hints.push("Acepta los términos pendientes de la cuenta publicitaria en el Administrador de anuncios de Meta y vuelve a intentarlo.");
  if (/venció|revocada/i.test(error)) hints.push("Reconecta Meta en Cuentas antes de volver a intentarlo.");
  if (/permisos|ads_management/i.test(error)) hints.push("Revisa el permiso ads_management y el acceso de tu usuario a la cuenta publicitaria y a la página (Manual, sección 8).");
  if (/tope mensual/i.test(error)) hints.push("Baja el presupuesto o la duración, pausa otro anuncio, o pídele al administrador que suba el tope mensual en Cuentas.");
  if (/problema temporal|exceso de consultas|No se pudo contactar/i.test(error)) hints.push("Parece un problema pasajero de Meta o de la red: espera unos minutos y vuelve a intentarlo, sin cambiar nada.");
  return hints;
}
