import "server-only";
import { clip, saveAccounts, type SaveItem, type SkippedAccount } from "@/lib/ads/save";
import { encryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import type { TikTokAssets } from "@/lib/tiktok/discover";
import type { TikTokToken } from "@/lib/tiktok/oauth";

export type TikTokSummary = {
  adAccountIds: string[];
  /** Cuentas que se guardaron de verdad (no las que TikTok listo). */
  adAccounts: number;
  skipped: (SkippedAccount | { id: string; reason: string })[];
};

/** Guarda (o actualiza) los anunciantes que la persona autorizo, con el token cifrado. */
export async function saveTikTokConnection(args: { userId: string; token: TikTokToken; assets: TikTokAssets }): Promise<TikTokSummary> {
  const { userId, token, assets } = args;
  const accessTokenEnc = encryptSecret(token.accessToken);

  const list: SaveItem[] = assets.accounts.map((a) => ({
    kind: "AD_ACCOUNT",
    externalId: a.id,
    data: {
      status: "ACTIVE",
      name: clip(a.name, 191),
      currency: a.currency ? clip(a.currency, 8) : null,
      timezone: a.timezone ? clip(a.timezone, 64) : null,
      scopes: token.scopes.join(","),
      connectedById: userId,
      lastError: null,
      accessTokenEnc,
      refreshTokenEnc: null,
      tokenExpiresAt: null, // el token de la Marketing API no vence solo
    },
  }));

  const { saved, skipped } = await saveAccounts("TIKTOK", list);
  const rows = list.length
    ? await db.socialAccount.findMany({
        where: { platform: "TIKTOK", kind: "AD_ACCOUNT", externalId: { in: list.map((i) => i.externalId) }, status: "ACTIVE" },
        select: { id: true },
      })
    : [];
  return { adAccountIds: rows.map((r) => r.id), adAccounts: saved.length, skipped: [...skipped, ...assets.skipped] };
}
