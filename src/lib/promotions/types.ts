// Tipos y textos de los anuncios hechos desde la app. Logica pura (sin servidor): la usan pantallas, validacion y pruebas.

export type PromotionKindName = "BOOST" | "AD";
export type PromotionObjectiveName = "AWARENESS" | "TRAFFIC" | "ENGAGEMENT";
export type PromotionStatusName = "CREATING" | "PAUSED" | "ACTIVE" | "FAILED" | "ARCHIVED";

export const KIND_LABELS: Record<PromotionKindName, string> = {
  BOOST: "Impulsar una publicación",
  AD: "Anuncio nuevo",
};

export const OBJECTIVE_LABELS: Record<PromotionObjectiveName, string> = {
  AWARENESS: "Que más gente lo vea",
  TRAFFIC: "Visitas a tu sitio web",
  ENGAGEMENT: "Más interacción",
};

export const OBJECTIVE_HINTS: Record<PromotionObjectiveName, string> = {
  AWARENESS: "Busca llegar a la mayor cantidad de personas distintas (alcance).",
  TRAFFIC: "Busca que la gente haga clic y entre a tu sitio web. Necesita un enlace.",
  ENGAGEMENT: "Busca reacciones, comentarios y compartidos de la publicación.",
};

/**
 * Que objetivos admite cada tipo. Al impulsar una publicacion ya hecha no se le puede agregar un enlace ni un boton,
 * asi que las visitas al sitio solo tienen sentido en un anuncio nuevo.
 */
export const OBJECTIVES_BY_KIND: Record<PromotionKindName, readonly PromotionObjectiveName[]> = {
  BOOST: ["ENGAGEMENT", "AWARENESS"],
  AD: ["TRAFFIC", "AWARENESS", "ENGAGEMENT"],
};

export const STATUS_LABELS: Record<PromotionStatusName, string> = {
  CREATING: "Creándose",
  PAUSED: "En pausa",
  ACTIVE: "Activo",
  FAILED: "No se pudo crear",
  ARCHIVED: "Archivado",
};

export const STATUS_TONES: Record<PromotionStatusName, "neutral" | "success" | "warning" | "danger" | "primary"> = {
  CREATING: "primary",
  PAUSED: "warning",
  ACTIVE: "success",
  FAILED: "danger",
  ARCHIVED: "neutral",
};

/** Estado «efectivo» que informa Meta (ya considera si la campaña o el conjunto estan en pausa, la revision, etc.). */
const EFFECTIVE_LABELS: Record<string, string> = {
  ACTIVE: "Activo",
  PAUSED: "En pausa",
  CAMPAIGN_PAUSED: "Campaña en pausa",
  ADSET_PAUSED: "Conjunto en pausa",
  PENDING_REVIEW: "En revisión de Meta",
  IN_PROCESS: "Procesándose en Meta",
  PREAPPROVED: "Preaprobado",
  DISAPPROVED: "Rechazado por Meta",
  WITH_ISSUES: "Con problemas",
  PENDING_BILLING_INFO: "Falta el método de pago",
  ARCHIVED: "Archivado",
  DELETED: "Eliminado",
  COMPLETED: "Terminado",
};

export function effectiveStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return EFFECTIVE_LABELS[status] ?? status;
}

/** Tono de color de un estado de Meta (verde activo, rojo si Meta lo rechazo o tiene problemas). */
export function effectiveStatusTone(status: string | null | undefined): "neutral" | "success" | "warning" | "danger" | "primary" {
  if (!status) return "neutral";
  if (status === "ACTIVE") return "success";
  if (status === "DISAPPROVED" || status === "WITH_ISSUES" || status === "PENDING_BILLING_INFO") return "danger";
  if (status === "PENDING_REVIEW" || status === "IN_PROCESS" || status === "PREAPPROVED") return "primary";
  if (status.includes("PAUSED")) return "warning";
  return "neutral";
}

/** Botones de llamada a la accion que Meta admite en un anuncio (valor de Meta -> texto en español). */
export const CTA_OPTIONS = [
  { value: "LEARN_MORE", label: "Más información" },
  { value: "SHOP_NOW", label: "Comprar" },
  { value: "CONTACT_US", label: "Contáctanos" },
  { value: "SIGN_UP", label: "Registrarte" },
  { value: "BOOK_NOW", label: "Reservar" },
  { value: "ORDER_NOW", label: "Pedir ahora" },
  { value: "GET_QUOTE", label: "Pedir cotización" },
  { value: "SUBSCRIBE", label: "Suscribirte" },
  { value: "NO_BUTTON", label: "Sin botón" },
] as const;
export type CtaType = (typeof CTA_OPTIONS)[number]["value"];
export const CTA_VALUES: readonly string[] = CTA_OPTIONS.map((c) => c.value);

/** Cuantos dias puede durar un anuncio hecho desde la app (el gasto maximo es presupuesto diario x dias). */
export const MIN_DURATION_DAYS = 1;
export const MAX_DURATION_DAYS = 30;

export type CityTarget = { key: string; name: string; countryCode: string; radiusKm: number };
export type InterestTarget = { id: string; name: string };

/** A quien se le muestra el anuncio. */
export type Targeting = {
  countries: string[];
  cities: CityTarget[];
  ageMin: number;
  ageMax: number;
  gender: "all" | "men" | "women";
  interests: InterestTarget[];
};

/** Lo que se ve en el anuncio. En un impulso solo importa lo que ya tiene la publicacion. */
export type CreativeInput = {
  message: string;
  headline: string | null;
  link: string | null;
  cta: CtaType | null;
  /** Archivo de la imagen (carpeta de medios) que se sube a Meta. Solo en un anuncio nuevo. */
  imageKey: string | null;
};

export type PromotionInput = {
  kind: PromotionKindName;
  objective: PromotionObjectiveName;
  name: string;
  /** En unidades normales de la moneda de la cuenta publicitaria (50000 COP, 10,5 USD). */
  dailyBudget: number;
  durationDays: number;
  targeting: Targeting;
  creative: CreativeInput;
};
