// Reglas por plataforma. Sin dependencias de servidor: las usa tambien el editor (contador de caracteres).

export const POST_PLATFORMS = ["facebook", "instagram", "both"] as const;
export type PostPlatform = (typeof POST_PLATFORMS)[number];

export const PLATFORM_LABELS: Record<PostPlatform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  both: "Facebook e Instagram",
};

export type PlatformLimits = {
  /** Maximo de caracteres del texto final (con hashtags). */
  maxChars: number;
  /** Hashtags que se dejan como maximo al generar. */
  maxHashtags: number;
};

/** Instagram: pie de hasta 2.200 caracteres y 30 hashtags (mas de ~10 rinde poco). Facebook: hasta 63.206, pero lo util es breve. */
export const PLATFORM_LIMITS: Record<PostPlatform, PlatformLimits> = {
  facebook: { maxChars: 5000, maxHashtags: 5 },
  instagram: { maxChars: 2200, maxHashtags: 10 },
  both: { maxChars: 2200, maxHashtags: 8 },
};

/** Limite de caracteres de un texto segun los destinos: el mas estricto manda. */
export function maxCharsFor(kinds: readonly ("FACEBOOK_PAGE" | "INSTAGRAM_PROFILE" | string)[]): number {
  const hasIg = kinds.includes("INSTAGRAM_PROFILE");
  const hasFb = kinds.includes("FACEBOOK_PAGE");
  if (hasIg) return PLATFORM_LIMITS.instagram.maxChars;
  if (hasFb) return PLATFORM_LIMITS.facebook.maxChars;
  return PLATFORM_LIMITS.both.maxChars;
}

export const LANGUAGES = { es: "español", en: "inglés", pt: "portugués" } as const;
export type LanguageCode = keyof typeof LANGUAGES;
