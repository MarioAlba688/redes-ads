import "server-only";
import { withAccountLock } from "@/lib/ads/lock";
import { replaceInsights } from "@/lib/ads/store";
import type { AdsConnector, AdsPlatform } from "@/lib/ads/types";
import { db } from "@/lib/db";
import { describeInternalError } from "@/lib/errors";
import { googleConnector } from "@/lib/google/connector";
import { addDays, todayInTimezone } from "@/lib/meta/dates";
import { metaConnector } from "@/lib/meta/connector";
import { ADS_PLATFORM_IDS, isAdsPlatform } from "@/lib/platforms";
import { tiktokConnector } from "@/lib/tiktok/connector";

// Sincronizacion de anuncios, igual para todas las plataformas: lo propio de cada una esta en su conector.

const CONNECTORS: Record<AdsPlatform, AdsConnector> = {
  META: metaConnector,
  GOOGLE_ADS: googleConnector,
  TIKTOK: tiktokConnector,
};

/** Plataformas de las que se sincronizan anuncios. */
export const ADS_PLATFORMS = [...ADS_PLATFORM_IDS];

export type SyncResult =
  | { ok: true; rows: number; since: string; until: string }
  | { ok: false; error: string };

const MAX_DAYS = 90; // las cifras de los ultimos dias son las que cambian; mas atras casi no se mueven

/**
 * Descarga el rendimiento de los ultimos `days` dias de una cuenta publicitaria (de cualquier plataforma) y lo guarda.
 * Nunca lanza: devuelve el resultado, y deja el estado de la cuenta al dia (EXPIRED si la plataforma dice que la
 * conexion ya no sirve).
 */
export async function syncAdAccount(accountId: string, opts: { days?: number } = {}): Promise<SyncResult> {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 30), 1), MAX_DAYS);

  const account = await db.socialAccount.findUnique({ where: { id: accountId } });
  if (!account || account.kind !== "AD_ACCOUNT" || !isAdsPlatform(account.platform)) {
    return { ok: false, error: "No es una cuenta publicitaria." };
  }
  if (!account.accessTokenEnc && !account.refreshTokenEnc) {
    return { ok: false, error: "La cuenta está desconectada. Vuelve a conectarla." };
  }
  if (account.status === "REVOKED") {
    return { ok: false, error: "La cuenta está desconectada. Vuelve a conectarla." };
  }

  const connector = CONNECTORS[account.platform];
  const notReady = connector.configError();
  if (notReady) return { ok: false, error: notReady };

  // Las fechas de los reportes van en la zona horaria de la cuenta, no en la del servidor.
  const until = todayInTimezone(account.timezone);
  const since = addDays(until, -(days - 1));

  const locked = await withAccountLock(account.id, async (): Promise<SyncResult> => {
    try {
      const rows = await connector.fetchInsights(account, { since, until });
      const stored = await replaceInsights(account.id, since, until, rows);
      await db.socialAccount.update({
        where: { id: account.id },
        data: { status: "ACTIVE", lastSyncedAt: new Date(), lastError: null },
      });
      return { ok: true, rows: stored, since, until };
    } catch (e) {
      const known = connector.classifyError(e);
      if (known) {
        await db.socialAccount.update({
          where: { id: account.id },
          data: { lastError: known.message, ...(known.expired ? { status: "EXPIRED" as const } : {}) },
        });
        return { ok: false, error: known.message };
      }
      // Error nuestro (clave de cifrado incorrecta, base de datos...): se registra sin datos sensibles.
      console.error(`[${connector.label}] fallo al sincronizar`, account.id, describeInternalError(e));
      const error = "No se pudo sincronizar por un error interno. Revisa los registros del servidor.";
      await db.socialAccount.update({ where: { id: account.id }, data: { lastError: error } });
      return { ok: false, error };
    }
  });
  return locked.ran ? locked.value : { ok: false, error: "Esta cuenta ya se está sincronizando. Espera unos segundos y vuelve a mirar." };
}

/** Borra los tokens y marca la cuenta como desconectada. El historial de rendimiento se conserva. */
export async function disconnectAccount(accountId: string) {
  return db.socialAccount.updateMany({
    where: { id: accountId, status: { not: "REVOKED" } },
    data: {
      status: "REVOKED",
      accessTokenEnc: null,
      refreshTokenEnc: null,
      tokenExpiresAt: null,
      lastError: null,
    },
  });
}
