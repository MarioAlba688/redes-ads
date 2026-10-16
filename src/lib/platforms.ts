export type PlatformId = "META" | "GOOGLE_ADS" | "TIKTOK" | "LINKEDIN";

export type PlatformInfo = {
  id: PlatformId;
  name: string;
  description: string;
  /** Fase del plan en la que se habilita la conexion. */
  phase: number;
};

export const PLATFORMS: readonly PlatformInfo[] = [
  {
    id: "META",
    name: "Meta",
    description: "Facebook, Instagram y Meta Ads",
    phase: 2,
  },
  {
    id: "GOOGLE_ADS",
    name: "Google Ads",
    description: "Campañas y métricas de Google Ads",
    phase: 4,
  },
  {
    id: "TIKTOK",
    name: "TikTok",
    description: "Campañas y métricas de TikTok Ads",
    phase: 4,
  },
  {
    id: "LINKEDIN",
    name: "LinkedIn",
    description: "LinkedIn Ads y páginas de empresa",
    phase: 5,
  },
];

/** Plataformas de las que se descargan anuncios (rendimiento de campañas). */
export const ADS_PLATFORM_IDS = ["META", "GOOGLE_ADS", "TIKTOK"] as const;
export type AdsPlatformId = (typeof ADS_PLATFORM_IDS)[number];
export const isAdsPlatform = (p: string): p is AdsPlatformId => (ADS_PLATFORM_IDS as readonly string[]).includes(p);

export const PLATFORM_NAMES: Record<PlatformId, string> = Object.fromEntries(
  PLATFORMS.map((p) => [p.id, p.name]),
) as Record<PlatformId, string>;

export const ACCOUNT_KIND_LABELS = {
  AD_ACCOUNT: "Cuenta publicitaria",
  FACEBOOK_PAGE: "Página de Facebook",
  INSTAGRAM_PROFILE: "Instagram",
  SOCIAL_PROFILE: "Página / perfil",
} as const;

export const CONNECTION_STATUS_LABELS = {
  ACTIVE: "Conectada",
  EXPIRED: "Vencida",
  ERROR: "Con error",
  REVOKED: "Desconectada",
} as const;
