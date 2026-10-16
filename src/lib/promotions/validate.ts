import { fromMinorUnits, toMinorUnits, budgetDecimals } from "@/lib/promotions/currency";
import { validateTargeting } from "@/lib/promotions/targeting";
import {
  CTA_VALUES,
  MAX_DURATION_DAYS,
  MIN_DURATION_DAYS,
  OBJECTIVES_BY_KIND,
  OBJECTIVE_LABELS,
  type PromotionInput,
} from "@/lib/promotions/types";

// Reglas de un anuncio antes de tocar Meta. Logica pura: devuelve una lista de mensajes en español (vacia = valido).

export type ValidationContext = {
  /** Moneda de la cuenta publicitaria (la de Meta). */
  currency: string | null;
  /** Tope de gasto diario fijado por el administrador, en unidades normales; null = todavia no hay. */
  cap: number | null;
  /** Para un anuncio nuevo: la publicacion de origen tiene imagen. */
  hasImage?: boolean;
};

const MAX_NAME = 200;
const MAX_MESSAGE = 2000;
const MAX_HEADLINE = 255;

/** ¿Es una direccion web completa con http o https? */
export function isWebUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * Comprueba presupuesto contra el tope (el control principal del gasto), duracion, segmentacion y contenido.
 * Sin tope fijado, no se puede crear nada: el administrador decide cuanto como maximo por dia.
 */
export function validatePromotion(input: PromotionInput, ctx: ValidationContext): string[] {
  const errors: string[] = [];

  if (!input.name.trim()) errors.push("Ponle un nombre al anuncio.");
  if (input.name.length > MAX_NAME) errors.push(`El nombre puede tener hasta ${MAX_NAME} caracteres.`);

  if (!OBJECTIVES_BY_KIND[input.kind].includes(input.objective)) {
    errors.push(`«${OBJECTIVE_LABELS[input.objective]}» no está disponible para ${input.kind === "BOOST" ? "impulsar una publicación" : "un anuncio nuevo"}.`);
  }

  // --- dinero ---
  if (ctx.currency === null || budgetDecimals(ctx.currency) === null) {
    errors.push(`La moneda de la cuenta publicitaria (${ctx.currency ?? "desconocida"}) no está en la tabla de Meta, así que no se puede calcular el presupuesto con seguridad.`);
  } else if (toMinorUnits(input.dailyBudget, ctx.currency) === null) {
    const decimals = budgetDecimals(ctx.currency);
    errors.push(
      decimals === 0
        ? `El presupuesto diario en ${ctx.currency} va sin decimales y debe ser mayor que 0.`
        : `El presupuesto diario debe ser mayor que 0 y con hasta ${decimals} decimales.`,
    );
  } else if (ctx.cap === null) {
    errors.push("Esta cuenta publicitaria todavía no tiene un tope de gasto diario. Pídele al administrador que lo fije en Cuentas.");
  } else if (input.dailyBudget > ctx.cap) {
    errors.push(`El presupuesto diario (${input.dailyBudget} ${ctx.currency}) supera el tope de esta cuenta (${ctx.cap} ${ctx.currency}).`);
  }

  if (!Number.isInteger(input.durationDays) || input.durationDays < MIN_DURATION_DAYS || input.durationDays > MAX_DURATION_DAYS) {
    errors.push(`La duración debe ser de ${MIN_DURATION_DAYS} a ${MAX_DURATION_DAYS} días.`);
  }

  errors.push(...validateTargeting(input.targeting));

  // --- contenido ---
  if (input.kind === "AD") {
    const c = input.creative;
    if (!c.message.trim()) errors.push("El anuncio necesita un texto.");
    if (c.message.length > MAX_MESSAGE) errors.push(`El texto puede tener hasta ${MAX_MESSAGE} caracteres.`);
    if (ctx.hasImage === false) errors.push("El anuncio necesita una imagen: la publicación elegida no tiene ninguna.");
    if (c.headline && c.headline.length > MAX_HEADLINE) errors.push(`El titular puede tener hasta ${MAX_HEADLINE} caracteres.`);
    if (input.objective === "TRAFFIC" && !c.link) errors.push("Para conseguir visitas a tu sitio web hace falta el enlace.");
    if (c.link && !isWebUrl(c.link)) errors.push("El enlace no es una dirección web válida (por ejemplo https://tusitio.com).");
    if (c.cta && !CTA_VALUES.includes(c.cta)) errors.push("El botón elegido no es válido.");
  }

  return errors;
}

/** Gasto maximo posible: presupuesto diario por los dias que dura. En unidades normales de la moneda. */
export function maxTotalSpend(dailyBudget: number, durationDays: number, currency: string | null): number | null {
  const minor = toMinorUnits(dailyBudget, currency);
  if (minor === null || !Number.isInteger(durationDays) || durationDays < 1) return null;
  return fromMinorUnits(minor * durationDays, currency);
}
