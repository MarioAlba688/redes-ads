// Etiquetas y reglas compartidas de las publicaciones (sin servidor: las usan pantallas de servidor y de cliente).

export const POST_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
] as const;
export type PostStatusName = (typeof POST_STATUSES)[number];

export const POST_STATUS_LABELS: Record<PostStatusName, string> = {
  DRAFT: "Borrador",
  IN_REVIEW: "En revisión",
  APPROVED: "Aprobada",
  SCHEDULED: "Programada",
  PUBLISHING: "Publicando",
  PUBLISHED: "Publicada",
  PARTIAL: "Publicada en parte",
  FAILED: "Falló",
  CANCELLED: "Cancelada",
};

export const POST_STATUS_TONES: Record<PostStatusName, "neutral" | "primary" | "success" | "warning" | "danger"> = {
  DRAFT: "neutral",
  IN_REVIEW: "warning",
  APPROVED: "primary",
  SCHEDULED: "primary",
  PUBLISHING: "primary",
  PUBLISHED: "success",
  PARTIAL: "warning",
  FAILED: "danger",
  CANCELLED: "neutral",
};

/** Formato de una publicacion: normal (texto e imagenes) o historia (una sola foto, sin texto). */
export const POST_FORMATS = ["FEED", "STORY"] as const;
export type PostFormatName = (typeof POST_FORMATS)[number];

export const POST_FORMAT_LABELS: Record<PostFormatName, string> = { FEED: "Publicación", STORY: "Historia" };

/** La nota interna de una historia (no se publica: por la API de Meta una historia sale sin texto). */
export const STORY_NOTE_MAX = 500;

/** Solo un borrador se puede editar; el resto es historia o esta en manos de otra persona. */
export const isEditable = (status: PostStatusName) => status === "DRAFT";

export const TARGET_STATUS_LABELS = {
  PENDING: "Pendiente",
  PUBLISHING: "Publicando",
  PUBLISHED: "Publicado",
  FAILED: "Falló",
} as const;

/** Tipos de cuenta donde se puede publicar. */
export const PUBLISHABLE_KINDS = ["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"] as const;
