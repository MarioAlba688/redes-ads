"use server";

import { revalidatePath } from "next/cache";
import * as z from "zod";
import { ADS_PLATFORMS, disconnectAccount, syncAdAccount } from "@/lib/ads/sync";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import type { FormState } from "@/lib/form-state";

const SYNC_DAYS = 30;

/** Prefijo de los eventos de auditoria de cada plataforma (meta.synced, google.synced...). */
const AUDIT_PREFIX = { META: "meta", GOOGLE_ADS: "google", TIKTOK: "tiktok", LINKEDIN: "linkedin" } as const;

const refresh = () => {
  revalidatePath("/cuentas");
  revalidatePath("/anuncios");
  revalidatePath("/");
};

export async function syncAccountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("accounts.manage");
  if (!auth.ok) return { error: auth.error };

  const id = z.string().min(1).safeParse(formData.get("accountId"));
  if (!id.success) return { error: "Datos no válidos." };

  const account = await db.socialAccount.findUnique({ where: { id: id.data }, select: { platform: true } });
  const result = await syncAdAccount(id.data, { days: SYNC_DAYS });
  await audit(`${AUDIT_PREFIX[account?.platform ?? "META"]}.synced`, {
    userId: auth.user.id,
    target: id.data,
    detail: result.ok ? { rows: result.rows } : { error: result.error },
  });
  refresh();
  return result.ok
    ? { success: `Sincronizado: ${result.rows} registros (${result.since} a ${result.until}).` }
    : { error: result.error };
}

/** Sincroniza todas las cuentas publicitarias conectadas, de cualquier plataforma. */
export async function syncAllAction(): Promise<FormState> {
  const auth = await authorize("accounts.manage");
  if (!auth.ok) return { error: auth.error };

  const accounts = await db.socialAccount.findMany({
    where: {
      platform: { in: ADS_PLATFORMS },
      kind: "AD_ACCOUNT",
      status: { in: ["ACTIVE", "EXPIRED", "ERROR"] },
      OR: [{ accessTokenEnc: { not: null } }, { refreshTokenEnc: { not: null } }],
    },
    select: { id: true, name: true },
  });
  if (accounts.length === 0) return { error: "No hay cuentas publicitarias conectadas." };

  // En orden y de a una: las plataformas limitan las consultas por cuenta y por app.
  let ok = 0;
  const failed: string[] = [];
  for (const account of accounts) {
    const result = await syncAdAccount(account.id, { days: SYNC_DAYS });
    if (result.ok) ok++;
    else failed.push(account.name);
  }
  await audit("ads.synced_all", { userId: auth.user.id, detail: { ok, failed: failed.length } });
  refresh();

  if (failed.length === 0) return { success: `Se sincronizaron ${ok} cuentas.` };
  return {
    error: `Se sincronizaron ${ok} de ${accounts.length}. Con problemas: ${failed.join(", ")} (el detalle está en cada cuenta).`,
  };
}

export async function disconnectAccountAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("accounts.manage");
  if (!auth.ok) return { error: auth.error };

  const id = z.string().min(1).safeParse(formData.get("accountId"));
  if (!id.success) return { error: "Datos no válidos." };

  const account = await db.socialAccount.findUnique({
    where: { id: id.data },
    select: { name: true, platform: true },
  });
  if (!account) return { error: "Esa cuenta ya no existe." };

  await disconnectAccount(id.data);
  await audit(`${AUDIT_PREFIX[account.platform]}.disconnected`, { userId: auth.user.id, target: account.name });
  refresh();
  return { success: "Cuenta desconectada." };
}
