import type { SocialAccount } from "@/generated/prisma/client";
import type { AdsPlatformId } from "@/lib/platforms";

/** Una fila de rendimiento: una campaña un dia. Es el formato comun de todas las plataformas de anuncios. */
export type InsightRow = {
  /** AAAA-MM-DD en la zona horaria de la cuenta publicitaria. */
  date: string;
  campaignId: string;
  campaignName: string;
  /** Decimal como texto, sin perder precision. */
  spend: string;
  impressions: number;
  clicks: number;
  /** Personas alcanzadas ese dia; 0 si la plataforma no lo informa (Google Ads). */
  reach: number;
  /** Conversiones y otras acciones como { tipo: cantidad }. */
  actions: Record<string, number> | null;
};

/** Plataformas de las que se descargan anuncios. */
export type AdsPlatform = AdsPlatformId;

/**
 * Lo que cada plataforma de anuncios aporta a la sincronizacion. Todo lo demas (calcular las fechas en la zona de la
 * cuenta, reemplazar la ventana guardada, actualizar el estado de la cuenta) es comun y esta en sync.ts.
 */
export type AdsConnector = {
  platform: AdsPlatform;
  /** Nombre para mensajes: «Meta», «Google Ads», «TikTok». */
  label: string;
  /** Texto en español si faltan credenciales en el servidor; null si esta listo. */
  configError(): string | null;
  /** Descarga el rendimiento diario por campaña entre dos fechas (AAAA-MM-DD, ambas incluidas). Puede lanzar. */
  fetchInsights(account: SocialAccount, range: { since: string; until: string }): Promise<InsightRow[]>;
  /**
   * Convierte un error de la plataforma en un mensaje para mostrar y dice si la conexion ya no sirve (hay que
   * reconectar). Devuelve null si el error no es de la plataforma (es nuestro: base de datos, cifrado...).
   */
  classifyError(e: unknown): { message: string; expired: boolean } | null;
};
