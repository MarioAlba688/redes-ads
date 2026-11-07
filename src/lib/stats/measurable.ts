import type { Prisma } from "@/generated/prisma/client";

// Que publicaciones tienen estadisticas que leer. Una foto o un carrusel, siempre. De un video, solo el Reel de
// Instagram: su id es el de un medio de Instagram, igual que el de una foto, y se lee con las mismas llamadas.
// El Reel de Facebook se publica por otro endpoint (video_reels): su id es el del video y sus metricas son otras, asi
// que todavia no se lee (no esta verificado con una cuenta real). Se lista igual, con un aviso, para que no parezca que
// no salio.

/** Lo que se le dice a quien mira un Reel de Facebook en Estadisticas o en la ficha de la publicacion. */
export const FACEBOOK_REEL_NOTICE = "Los Reels de Facebook todavía no tienen estadísticas en esta app; mira sus cifras en Facebook.";

/** ¿Se leen las estadisticas de este destino ya publicado? Todo menos un video de Facebook. */
export function isMeasurable(t: { accountKind: string; isVideo: boolean }): boolean {
  return !t.isVideo || t.accountKind === "INSTAGRAM_PROFILE";
}

/** Lo mismo que `isMeasurable`, para filtrar en la base de datos. */
export const MEASURABLE_WHERE: Prisma.PostTargetWhereInput = {
  OR: [{ account: { kind: "INSTAGRAM_PROFILE" } }, { post: { media: { none: { kind: "VIDEO" } } } }],
};
