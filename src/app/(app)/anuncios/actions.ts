"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as z from "zod";
import { authorize } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import type { FormState } from "@/lib/form-state";
import { can } from "@/lib/permissions";
import { parseBudgetInput } from "@/lib/promotions/currency";
import { setExistingBudget, setExistingStatus } from "@/lib/promotions/manage";
import { activatePromotion, archivePromotion, changePromotionBudget, createPromotion, pausePromotion, syncPromotion } from "@/lib/promotions/service";
import { CTA_VALUES } from "@/lib/promotions/types";

// Acciones del servidor de los anuncios. Cada una comprueba el permiso (crear anuncios en pausa y pausarlos: ads.create;
// activar, cambiar presupuesto y archivar, que mueven dinero: ads.approve) y delega en src/lib/promotions, donde estan
// las protecciones del gasto. Este archivo solo exporta acciones.

const refresh = () => revalidatePath("/anuncios", "layout");

const payloadSchema = z.object({
  adAccountId: z.string().min(1),
  kind: z.enum(["BOOST", "AD"]),
  targetId: z.string().min(1).optional(),
  postId: z.string().min(1).optional(),
  pageAccountId: z.string().min(1).optional(),
  objective: z.enum(["AWARENESS", "TRAFFIC", "ENGAGEMENT"]),
  name: z.string().trim().min(1, "Ponle un nombre al anuncio.").max(200),
  /** Texto tal como lo escribio la persona: se interpreta con la moneda de la cuenta, en el servidor. */
  dailyBudget: z.string().max(40),
  durationDays: z.number().int(),
  targeting: z.object({
    countries: z.array(z.string().max(4)).max(30),
    cities: z.array(z.object({ key: z.string().max(40), name: z.string().max(200), countryCode: z.string().max(4), radiusKm: z.number() })).max(30),
    ageMin: z.number().int(),
    ageMax: z.number().int(),
    gender: z.enum(["all", "men", "women"]),
    interests: z.array(z.object({ id: z.string().max(40), name: z.string().max(200) })).max(20),
  }),
  creative: z.object({
    message: z.string().max(5000),
    headline: z.string().max(300).nullable(),
    link: z.string().max(2000).nullable(),
    cta: z.string().nullable(),
  }),
});

/** Crea un anuncio (siempre en pausa). El formulario es complejo, asi que viaja entero como JSON en un solo campo. */
export async function createPromotionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("ads.create");
  if (!auth.ok) return { error: auth.error };

  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return { error: "Datos no válidos." };
  }
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos no válidos." };
  const p = parsed.data;

  const account = await db.socialAccount.findUnique({ where: { id: p.adAccountId }, select: { currency: true, platform: true, kind: true } });
  if (!account || account.platform !== "META" || account.kind !== "AD_ACCOUNT") return { error: "Esa cuenta publicitaria no existe." };
  const dailyBudget = parseBudgetInput(p.dailyBudget, account.currency);
  if (dailyBudget === null) {
    return { error: `No entendí el presupuesto «${p.dailyBudget}». Escríbelo en ${account.currency ?? "la moneda de la cuenta"}, mayor que 0 y con los decimales que admite la moneda.` };
  }
  if (p.creative.cta !== null && !CTA_VALUES.includes(p.creative.cta)) return { error: "El botón elegido no es válido." };

  let source: Parameters<typeof createPromotion>[1]["source"];
  if (p.kind === "BOOST") {
    if (!p.targetId) return { error: "Elige la publicación que quieres impulsar." };
    source = { kind: "BOOST", targetId: p.targetId };
  } else {
    if (!p.postId) return { error: "Elige la publicación de la que sale el anuncio." };
    if (!p.pageAccountId) return { error: "Elige la página de Facebook desde la que se publica el anuncio." };
    source = { kind: "AD", postId: p.postId, pageAccountId: p.pageAccountId };
  }

  const result = await createPromotion(auth.user.id, {
    adAccountId: p.adAccountId,
    source,
    objective: p.objective,
    name: p.name,
    dailyBudget,
    durationDays: p.durationDays,
    targeting: p.targeting,
    creative: { message: p.creative.message, headline: p.creative.headline, link: p.creative.link, cta: p.creative.cta as never },
  });
  if (!result.ok) return { error: result.error };
  refresh();
  redirect(`/anuncios/creados/${result.id}?creado=1`);
}

const idSchema = z.string().min(1);

/** Activa un anuncio en pausa: lo que empieza a gastar. Solo quien aprueba. */
export async function activatePromotionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("ads.approve");
  if (!auth.ok) return { error: auth.error };
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { error: "Datos no válidos." };
  const r = await activatePromotion(auth.user.id, id.data);
  refresh();
  return r.ok ? { success: "Anuncio activado. Meta lo revisa antes de mostrarlo." } : { error: r.error };
}

/** Pausa un anuncio. Pausar nunca gasta, asi que puede quien lo crea o quien lo aprueba. */
export async function pausePromotionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize();
  if (!auth.ok) return { error: auth.error };
  if (!can(auth.user.role, "ads.create") && !can(auth.user.role, "ads.approve")) return { error: "No tienes permiso para hacer esto." };
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { error: "Datos no válidos." };
  const r = await pausePromotion(auth.user.id, id.data);
  refresh();
  return r.ok ? { success: "Anuncio en pausa." } : { error: r.error };
}

/** Cambia el presupuesto diario (sin pasar del tope). Subirlo mueve dinero, asi que solo quien aprueba. */
export async function changeBudgetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("ads.approve");
  if (!auth.ok) return { error: auth.error };
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { error: "Datos no válidos." };
  const text = String(formData.get("budget") ?? "");

  const promo = await db.adPromotion.findUnique({ where: { id: id.data }, select: { currency: true } });
  if (!promo) return { error: "Ese anuncio ya no existe." };
  const budget = parseBudgetInput(text, promo.currency);
  if (budget === null) return { error: `No entendí «${text}». Escribe el monto en ${promo.currency}, mayor que 0 y con los decimales que admite la moneda.`, values: { budget: text } };

  const r = await changePromotionBudget(auth.user.id, id.data, budget);
  refresh();
  return r.ok ? { success: "Presupuesto actualizado." } : { error: r.error, values: { budget: text } };
}

export async function archivePromotionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("ads.approve");
  if (!auth.ok) return { error: auth.error };
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { error: "Datos no válidos." };
  const r = await archivePromotion(auth.user.id, id.data);
  refresh();
  return r.ok ? { success: "Anuncio archivado." } : { error: r.error };
}

/** Vuelve a leer en Meta el estado de un anuncio. */
export async function syncPromotionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize();
  if (!auth.ok) return { error: auth.error };
  if (!can(auth.user.role, "ads.create") && !can(auth.user.role, "ads.approve")) return { error: "No tienes permiso para hacer esto." };
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { error: "Datos no válidos." };
  const r = await syncPromotion(id.data);
  refresh();
  return r.ok ? { success: "Estado actualizado." } : { error: r.error };
}

// ---------------------------------------------------------------------------
// Lo que ya existe en la cuenta publicitaria (campañas creadas en Meta)
// ---------------------------------------------------------------------------

const existingSchema = z.object({
  adAccountId: z.string().min(1),
  level: z.enum(["campaign", "adset", "ad"]),
  objectId: z.string().min(1).max(64),
});

/** Activa o pausa una campaña, un conjunto de anuncios o un anuncio de la cuenta. Activar solo quien aprueba. */
export async function setExistingStatusAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const status = formData.get("status") === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const auth = await authorize();
  if (!auth.ok) return { error: auth.error };
  const allowed = status === "ACTIVE" ? can(auth.user.role, "ads.approve") : can(auth.user.role, "ads.create") || can(auth.user.role, "ads.approve");
  if (!allowed) return { error: "No tienes permiso para hacer esto." };
  const p = existingSchema.safeParse({ adAccountId: formData.get("adAccountId"), level: formData.get("level"), objectId: formData.get("objectId") });
  if (!p.success) return { error: "Datos no válidos." };
  const r = await setExistingStatus(auth.user.id, p.data.adAccountId, p.data.level, p.data.objectId, status);
  refresh();
  return r.ok ? { success: status === "ACTIVE" ? "Activado." : "En pausa." } : { error: r.error };
}

export async function setExistingBudgetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("ads.approve");
  if (!auth.ok) return { error: auth.error };
  const p = existingSchema.safeParse({ adAccountId: formData.get("adAccountId"), level: formData.get("level"), objectId: formData.get("objectId") });
  if (!p.success) return { error: "Datos no válidos." };
  const text = String(formData.get("budget") ?? "");
  const account = await db.socialAccount.findUnique({ where: { id: p.data.adAccountId }, select: { currency: true } });
  const budget = parseBudgetInput(text, account?.currency);
  if (budget === null) return { error: `No entendí «${text}». Escribe el monto en ${account?.currency ?? "la moneda de la cuenta"}, mayor que 0 y con los decimales que admite la moneda.`, values: { budget: text } };
  const r = await setExistingBudget(auth.user.id, p.data.adAccountId, p.data.level, p.data.objectId, budget);
  refresh();
  return r.ok ? { success: "Presupuesto actualizado." } : { error: r.error, values: { budget: text } };
}
