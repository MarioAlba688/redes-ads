import "server-only";
import { clip, saveAccounts, type AccountData, type SkippedAccount } from "@/lib/ads/save";
import { encryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { META_REQUIRED_SCOPE } from "@/lib/meta/config";
import type { MetaAssets } from "@/lib/meta/discover";
import type { LongLivedToken } from "@/lib/meta/oauth";

type AccountKindName = "AD_ACCOUNT" | "FACEBOOK_PAGE" | "INSTAGRAM_PROFILE";
type Item = { kind: AccountKindName; externalId: string; data: AccountData };

export type ConnectSummary = {
  adAccountIds: string[];
  /** Cuentas que se guardaron de verdad (no las que Meta listo). */
  adAccounts: number;
  pages: number;
  instagram: number;
  /** Cuentas que no se pudieron guardar, con el motivo. Una cuenta con problemas no tumba a las demas. */
  skipped: SkippedAccount[];
  /** La persona no concedio ads_read: no se pueden leer anuncios. */
  missingAdsRead: boolean;
};

/**
 * Guarda (o actualiza) las cuentas que la persona conecto. Los tokens se cifran;
 * volver a conectar reactiva las cuentas existentes en lugar de duplicarlas.
 *
 * Cada cuenta se guarda por separado, sin una transaccion que las envuelva a todas: con muchas
 * cuentas y la base en otro servidor, una transaccion unica supera el tiempo maximo de Prisma
 * (5 s) y la conexion entera fallaba. Asi, ademas, una cuenta problematica queda en `skipped`
 * sin impedir que se guarden las demas.
 */
export async function saveMetaConnection(args: {
  userId: string;
  assets: MetaAssets;
  userToken: LongLivedToken;
}): Promise<ConnectSummary> {
  const { userId, assets, userToken } = args;
  const common = { status: "ACTIVE" as const, scopes: assets.grantedScopes.join(","), connectedById: userId, lastError: null };
  const userTokenEnc = encryptSecret(userToken.accessToken);

  // Una sola entrada por cuenta: Meta puede listar la misma dos veces (propia y de un cliente).
  const items = new Map<string, Item>();
  const add = (kind: AccountKindName, externalId: string, data: AccountData) => {
    if (externalId) items.set(`${kind}:${externalId}`, { kind, externalId: clip(externalId, 191), data });
  };

  for (const ad of assets.adAccounts) {
    add("AD_ACCOUNT", ad.id, {
      ...common,
      name: clip(ad.name, 191),
      currency: ad.currency ? clip(ad.currency, 8) : null,
      timezone: ad.timezone ? clip(ad.timezone, 64) : null,
      metadata: { accountStatus: ad.accountStatus },
      accessTokenEnc: userTokenEnc,
      tokenExpiresAt: userToken.expiresAt,
    });
  }
  for (const page of assets.pages) {
    // Sin token de pagina no se podra publicar; no la guardamos a medias.
    if (!page.accessToken) continue;
    const pageTokenEnc = encryptSecret(page.accessToken);
    add("FACEBOOK_PAGE", page.id, {
      ...common,
      name: clip(page.name, 191),
      accessTokenEnc: pageTokenEnc,
      tokenExpiresAt: null, // el token de pagina no vence mientras el de la persona siga valido
    });
    if (page.instagram) {
      const ig = page.instagram;
      add("INSTAGRAM_PROFILE", ig.id, {
        ...common,
        name: clip(ig.name ?? ig.username ?? `Instagram ${ig.id}`, 191),
        handle: ig.username ? clip(`@${ig.username}`, 191) : null,
        metadata: { pageId: page.id },
        // Instagram se maneja con el token de la pagina vinculada.
        accessTokenEnc: pageTokenEnc,
        tokenExpiresAt: null,
      });
    }
  }

  const list = [...items.values()];
  const { saved: savedKinds, skipped } = await saveAccounts("META", list);

  const adIds = list.filter((i) => i.kind === "AD_ACCOUNT").map((i) => i.externalId);
  const adRows = adIds.length
    ? await db.socialAccount.findMany({
        where: { platform: "META", kind: "AD_ACCOUNT", externalId: { in: adIds }, status: "ACTIVE" },
        select: { id: true },
      })
    : [];

  const count = (k: AccountKindName) => savedKinds.filter((s) => s === k).length;
  return {
    adAccountIds: adRows.map((r) => r.id),
    adAccounts: count("AD_ACCOUNT"),
    pages: count("FACEBOOK_PAGE"),
    instagram: count("INSTAGRAM_PROFILE"),
    skipped,
    missingAdsRead: !assets.grantedScopes.includes(META_REQUIRED_SCOPE),
  };
}
