import { fromMinorUnits } from "@/lib/promotions/currency";

// Reglas para administrar lo que YA existe en la cuenta publicitaria (campañas creadas en Meta o en la app).
// Logica pura: recibe lo que informo Meta y decide si se puede activar sin pasar del tope. No llama a nadie.

export type ExistingLevel = "campaign" | "adset" | "ad";

type Campaign = { id: string; dailyBudgetMinor: number | null; lifetimeBudgetMinor: number | null; status?: string | null };
type AdSet = { id: string; campaignId: string | null; dailyBudgetMinor: number | null; lifetimeBudgetMinor: number | null; status?: string | null };
type Ad = { id: string; adSetId: string | null; campaignId: string | null };

export type ExistingObjects = { campaigns: Campaign[]; adSets: AdSet[]; ads: Ad[] };

const isGone = (status: string | null | undefined) => status === "DELETED" || status === "ARCHIVED";

/** Gasto diario maximo que puede generar activar ese objeto, en unidades minimas, o un motivo por el que no se puede calcular. */
export function dailyExposure(objects: ExistingObjects, level: ExistingLevel, id: string): { minor: number } | { reason: string } {
  const campaign = (cid: string | null) => objects.campaigns.find((c) => c.id === cid);
  const adSetsOf = (cid: string) => objects.adSets.filter((s) => s.campaignId === cid && !isGone(s.status));

  let campaignId: string | null;
  let adSets: AdSet[];
  if (level === "campaign") {
    campaignId = id;
    adSets = adSetsOf(id);
  } else if (level === "adset") {
    const set = objects.adSets.find((s) => s.id === id);
    if (!set) return { reason: "No se encontró ese conjunto de anuncios en la cuenta." };
    campaignId = set.campaignId;
    adSets = [set];
  } else {
    const ad = objects.ads.find((a) => a.id === id);
    if (!ad) return { reason: "No se encontró ese anuncio en la cuenta." };
    const set = objects.adSets.find((s) => s.id === ad.adSetId);
    if (!set) return { reason: "No se encontró el conjunto de anuncios de ese anuncio." };
    campaignId = set.campaignId;
    adSets = [set];
  }

  const parent = campaign(campaignId);
  if (!parent && level === "campaign") return { reason: "No se encontró esa campaña en la cuenta." };

  if (parent?.lifetimeBudgetMinor || adSets.some((s) => s.lifetimeBudgetMinor)) {
    return { reason: "Tiene un presupuesto total (no diario), que esta app no controla contra el tope. Actívalo directamente en Meta." };
  }
  // Presupuesto de campaña: es el que gasta; si no hay, gasta la suma de los conjuntos de anuncios.
  if (parent?.dailyBudgetMinor) return { minor: parent.dailyBudgetMinor };
  const withBudget = adSets.map((s) => s.dailyBudgetMinor);
  if (withBudget.length === 0) return { minor: 0 };
  if (withBudget.some((b) => b === null)) return { reason: "Un conjunto de anuncios no tiene presupuesto diario que se pueda comprobar. Actívalo directamente en Meta." };
  return { minor: (withBudget as number[]).reduce((a, b) => a + b, 0) };
}

/**
 * Motivo por el que NO se debe activar (null = se puede): sin tope fijado, con presupuesto total, o con un gasto diario
 * por encima del tope. En una campaña cuenta la suma de lo que pueden gastar sus conjuntos de anuncios.
 */
export function activationCapError(
  objects: ExistingObjects,
  level: ExistingLevel,
  id: string,
  ctx: { currency: string | null; cap: number | null },
): string | null {
  if (ctx.cap === null) return "Esta cuenta publicitaria todavía no tiene un tope de gasto diario. Pídele al administrador que lo fije en Cuentas.";
  const exposure = dailyExposure(objects, level, id);
  if ("reason" in exposure) return exposure.reason;
  const daily = fromMinorUnits(exposure.minor, ctx.currency);
  if (daily === null) return `La moneda de la cuenta (${ctx.currency ?? "desconocida"}) no está en la tabla de Meta: no se puede comprobar el presupuesto.`;
  if (daily > ctx.cap) {
    const what = level === "campaign" ? "El gasto diario de esta campaña" : "El presupuesto diario";
    return `${what} (${daily} ${ctx.currency}) supera el tope de la cuenta (${ctx.cap} ${ctx.currency}). Bájalo en Meta o pídele al administrador que suba el tope.`;
  }
  return null;
}

/** ¿Que objeto de la cuenta tiene el presupuesto diario que se puede cambiar desde la app? (la campaña si lo tiene ella; si no, el conjunto). */
export function budgetHolder(objects: ExistingObjects, level: ExistingLevel, id: string): { level: "campaign" | "adset"; id: string; dailyMinor: number } | { reason: string } {
  if (level === "ad") return { reason: "El presupuesto se cambia en el conjunto de anuncios o en la campaña, no en el anuncio." };
  if (level === "campaign") {
    const c = objects.campaigns.find((x) => x.id === id);
    if (!c) return { reason: "No se encontró esa campaña en la cuenta." };
    if (c.lifetimeBudgetMinor) return { reason: "Tiene un presupuesto total, no diario: cámbialo en Meta." };
    if (!c.dailyBudgetMinor) return { reason: "El presupuesto de esta campaña está en sus conjuntos de anuncios: cámbialo ahí." };
    return { level: "campaign", id, dailyMinor: c.dailyBudgetMinor };
  }
  const s = objects.adSets.find((x) => x.id === id);
  if (!s) return { reason: "No se encontró ese conjunto de anuncios en la cuenta." };
  if (s.lifetimeBudgetMinor) return { reason: "Tiene un presupuesto total, no diario: cámbialo en Meta." };
  if (!s.dailyBudgetMinor) return { reason: "Este conjunto no tiene presupuesto propio: lo tiene su campaña." };
  return { level: "adset", id, dailyMinor: s.dailyBudgetMinor };
}
