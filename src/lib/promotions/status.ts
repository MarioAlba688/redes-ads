// Estados de un anuncio segun Meta. Logica pura.

/** Estado local que corresponde a lo que informa Meta, o null para dejar el que hay (en revision, con problemas...). */
export function statusFromMeta(effective: string | null | undefined): "ACTIVE" | "PAUSED" | "ARCHIVED" | null {
  if (!effective) return null;
  if (effective === "ACTIVE") return "ACTIVE";
  if (effective === "PAUSED" || effective === "CAMPAIGN_PAUSED" || effective === "ADSET_PAUSED") return "PAUSED";
  if (effective === "ARCHIVED" || effective === "DELETED") return "ARCHIVED";
  return null;
}
