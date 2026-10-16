import type { CtaType, PromotionObjectiveName } from "@/lib/promotions/types";

// Traduccion de un anuncio de la app a los parametros de la Marketing API de Meta (v26). Logica pura.
// TODO lo que depende de como Meta nombra las cosas esta aqui: si Meta cambia un nombre o una combinacion, este es el
// unico archivo que se toca. Las combinaciones salen de la documentacion oficial (consultada el 2026-10-16) y aun no se
// probaron con una cuenta real: por eso todo se crea en pausa y los errores de Meta se muestran tal cual.

export type GraphValue = string | number | boolean;
export type GraphBody = Record<string, GraphValue>;

type ObjectiveRule = {
  /** Objetivo de campaña (esquema ODAX, el unico vigente desde la v17). */
  campaign: string;
  optimizationGoal: string;
  billingEvent: "IMPRESSIONS";
  /** Donde ocurre el resultado; null = no se manda. */
  destinationType: string | null;
  /** El conjunto de anuncios promueve una pagina (hace falta `promoted_object.page_id`). */
  promotesPage: boolean;
};

export const OBJECTIVE_RULES: Record<PromotionObjectiveName, ObjectiveRule> = {
  AWARENESS: { campaign: "OUTCOME_AWARENESS", optimizationGoal: "REACH", billingEvent: "IMPRESSIONS", destinationType: null, promotesPage: false },
  TRAFFIC: { campaign: "OUTCOME_TRAFFIC", optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS", destinationType: "WEBSITE", promotesPage: false },
  ENGAGEMENT: { campaign: "OUTCOME_ENGAGEMENT", optimizationGoal: "POST_ENGAGEMENT", billingEvent: "IMPRESSIONS", destinationType: "ON_POST", promotesPage: true },
};

/** Campaña. Siempre en pausa. `special_ad_categories` es obligatorio: [] = anuncio comun (no de empleo, vivienda, credito...). */
export function campaignBody(name: string, objective: PromotionObjectiveName): GraphBody {
  return {
    name,
    objective: OBJECTIVE_RULES[objective].campaign,
    status: "PAUSED",
    special_ad_categories: "[]",
    // El presupuesto va en el conjunto de anuncios, no en la campaña: Meta pide declarar que no se comparte.
    is_adset_budget_sharing_enabled: false,
  };
}

/** Conjunto de anuncios: presupuesto diario, fechas, a quien y que se optimiza. Siempre en pausa. */
export function adSetBody(p: {
  name: string;
  campaignId: string;
  objective: PromotionObjectiveName;
  dailyBudgetMinor: number;
  endsAt: Date;
  targeting: Record<string, unknown>;
  pageId: string;
}): GraphBody {
  const rule = OBJECTIVE_RULES[p.objective];
  const body: GraphBody = {
    name: p.name,
    campaign_id: p.campaignId,
    status: "PAUSED",
    daily_budget: p.dailyBudgetMinor,
    billing_event: rule.billingEvent,
    optimization_goal: rule.optimizationGoal,
    // Sin campaña con presupuesto propio, la estrategia de puja se declara aqui. Es la de menor costo, sin tope de puja.
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    end_time: Math.floor(p.endsAt.getTime() / 1000),
    targeting: JSON.stringify(p.targeting),
  };
  if (rule.destinationType) body.destination_type = rule.destinationType;
  if (rule.promotesPage) body.promoted_object = JSON.stringify({ page_id: p.pageId });
  return body;
}

/** Creativo para impulsar una publicacion de Facebook ya publicada: se referencia por su id (`<pagina>_<publicacion>`). */
export function facebookBoostCreativeBody(name: string, postId: string): GraphBody {
  return { name, object_story_id: postId };
}

/** Creativo para impulsar una publicacion de Instagram ya publicada (necesita la pagina vinculada y la cuenta de Instagram). */
export function instagramBoostCreativeBody(name: string, p: { pageId: string; instagramUserId: string; mediaId: string }): GraphBody {
  return { name, object_id: p.pageId, instagram_user_id: p.instagramUserId, source_instagram_media_id: p.mediaId };
}

/**
 * Creativo de un anuncio nuevo: una publicacion que solo existe como anuncio (no aparece en la pagina). Con enlace es un
 * anuncio de enlace (texto, titular, boton); sin enlace, una foto con su texto.
 */
export function newAdCreativeBody(p: {
  name: string;
  pageId: string;
  instagramUserId: string | null;
  imageHash: string;
  message: string;
  headline: string | null;
  link: string | null;
  cta: CtaType | null;
}): GraphBody {
  const spec: Record<string, unknown> = { page_id: p.pageId };
  if (p.instagramUserId) spec.instagram_user_id = p.instagramUserId;
  if (p.link) {
    const cta = p.cta ?? "LEARN_MORE";
    spec.link_data = {
      image_hash: p.imageHash,
      link: p.link,
      message: p.message,
      ...(p.headline ? { name: p.headline } : {}),
      ...(cta === "NO_BUTTON" ? {} : { call_to_action: { type: cta, value: { link: p.link } } }),
    };
  } else {
    spec.photo_data = { image_hash: p.imageHash, caption: p.message };
  }
  return { name: p.name, object_story_spec: JSON.stringify(spec) };
}

/**
 * Meta a veces responde «Creative Must Provide enroll_status for Standard Enhancements». En ese caso se repite la
 * creacion del creativo sin las mejoras automaticas de Meta (que cambian el texto o la imagen sin avisar).
 */
export const STANDARD_ENHANCEMENTS_ERROR = /standard enhancements|enroll_status/i;
export function withStandardEnhancementsOptOut(body: GraphBody): GraphBody {
  return {
    ...body,
    degrees_of_freedom_spec: JSON.stringify({ creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } } }),
  };
}

/** Anuncio: une el conjunto de anuncios con el creativo. Siempre en pausa. */
export function adBody(name: string, adSetId: string, creativeId: string): GraphBody {
  return { name, adset_id: adSetId, creative: JSON.stringify({ creative_id: creativeId }), status: "PAUSED" };
}
