import "server-only";
import type { SocialAccount } from "@/generated/prisma/client";
import { clip, saveAccounts, type SaveItem, type SkippedAccount } from "@/lib/ads/save";
import { decryptSecret, encryptSecret, sha256Hex } from "@/lib/crypto";
import { db } from "@/lib/db";
import type { GoogleAssets } from "@/lib/google/discover";
import { GoogleApiError } from "@/lib/google/errors";
import { refreshAccessToken, type GoogleTokens } from "@/lib/google/oauth";

/** Datos propios de Google que se guardan en `SocialAccount.metadata` (no en `tokenExpiresAt`: ese vence cada hora). */
type GoogleMetadata = { loginCustomerId: string | null; accessExpiresAt: string | null; email: string | null };

const readMetadata = (account: Pick<SocialAccount, "metadata">): GoogleMetadata => {
  const m = (account.metadata ?? {}) as Partial<GoogleMetadata>;
  return { loginCustomerId: m.loginCustomerId ?? null, accessExpiresAt: m.accessExpiresAt ?? null, email: m.email ?? null };
};

export const loginCustomerIdOf = (account: Pick<SocialAccount, "metadata">) => readMetadata(account).loginCustomerId;

export type GoogleSummary = {
  adAccountIds: string[];
  /** Cuentas que se guardaron de verdad (no las que Google listo). */
  adAccounts: number;
  skipped: (SkippedAccount | { id: string; reason: string })[];
};

/** Guarda (o actualiza) las cuentas de Google Ads que la persona conecto, con los tokens cifrados. */
export async function saveGoogleConnection(args: {
  userId: string;
  tokens: GoogleTokens & { refreshToken: string };
  assets: GoogleAssets;
}): Promise<GoogleSummary> {
  const { userId, tokens, assets } = args;
  const accessTokenEnc = encryptSecret(tokens.accessToken);
  const refreshTokenEnc = encryptSecret(tokens.refreshToken);

  const list: SaveItem[] = assets.accounts.map((c) => ({
    kind: "AD_ACCOUNT",
    externalId: c.id,
    data: {
      status: "ACTIVE",
      name: clip(c.name, 191),
      currency: c.currency ? clip(c.currency, 8) : null,
      timezone: c.timezone ? clip(c.timezone, 64) : null,
      scopes: tokens.scopes.join(","),
      connectedById: userId,
      lastError: null,
      accessTokenEnc,
      refreshTokenEnc,
      // Sin fecha: el token de renovacion no vence solo, y el de acceso (1 hora) se renueva solo al usarlo.
      tokenExpiresAt: null,
      metadata: { loginCustomerId: c.loginCustomerId, accessExpiresAt: tokens.expiresAt.toISOString(), email: tokens.email },
    },
  }));

  const { saved, skipped } = await saveAccounts("GOOGLE_ADS", list);
  const rows = list.length
    ? await db.socialAccount.findMany({
        where: { platform: "GOOGLE_ADS", kind: "AD_ACCOUNT", externalId: { in: list.map((i) => i.externalId) }, status: "ACTIVE" },
        select: { id: true },
      })
    : [];
  return {
    adAccountIds: rows.map((r) => r.id),
    adAccounts: saved.length,
    skipped: [...skipped, ...assets.skipped],
  };
}

// Token de acceso por token de renovacion, en memoria: una sincronizacion de muchas cuentas de la misma conexion
// pediria uno nuevo por cada cuenta; asi se pide uno por hora.
const accessCache = new Map<string, { accessToken: string; expiresAt: number }>();
const MARGIN_MS = 60_000;

/**
 * Token de acceso valido de una cuenta: el guardado si todavia sirve, o uno nuevo pedido con el token de renovacion
 * (que se guarda cifrado). Lanza GoogleApiError con `invalid_grant` si la conexion ya no se puede renovar.
 */
export async function accessTokenFor(account: SocialAccount): Promise<string> {
  const meta = readMetadata(account);
  const expiresAt = meta.accessExpiresAt ? Date.parse(meta.accessExpiresAt) : 0;
  if (account.accessTokenEnc && expiresAt - Date.now() > MARGIN_MS) return decryptSecret(account.accessTokenEnc);

  if (!account.refreshTokenEnc) {
    throw new GoogleApiError({ message: "La cuenta no tiene token de renovacion.", oauthError: "invalid_grant" });
  }
  const refreshToken = decryptSecret(account.refreshTokenEnc);
  const key = sha256Hex(refreshToken);
  const cached = accessCache.get(key);
  let fresh = cached && cached.expiresAt - Date.now() > MARGIN_MS ? cached : null;
  if (!fresh) {
    const r = await refreshAccessToken(refreshToken);
    fresh = { accessToken: r.accessToken, expiresAt: r.expiresAt.getTime() };
    accessCache.set(key, fresh);
  }
  await db.socialAccount.update({
    where: { id: account.id },
    data: { accessTokenEnc: encryptSecret(fresh.accessToken), metadata: { ...meta, accessExpiresAt: new Date(fresh.expiresAt).toISOString() } },
  });
  return fresh.accessToken;
}
