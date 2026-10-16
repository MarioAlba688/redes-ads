"use server";

import { revalidatePath } from "next/cache";
import * as z from "zod";
import { ADS_PLATFORMS, disconnectAccount, syncAdAccount } from "@/lib/ads/sync";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import type { FormState } from "@/lib/form-state";
import { formatMoney } from "@/lib/format";
import { budgetDecimals, parseBudgetInput } from "@/lib/promotions/currency";

const SYNC_DAYS = 30;

/** Prefijo de los eventos de auditoria de cada plataforma (meta.synced, google.synced...). */
const AUDIT_PREFIX = { META: "meta", GOOGLE_ADS: "google", TIKTOK: "tiktok", LINKEDIN: "linkedin" } as const;

const refresh = () => {
  revalidatePath("/cuentas");
  revalidatePath("/anuncios", "layout");
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

/**
 * Fija (o quita) el tope de gasto diario por anuncio de una cuenta publicitaria de Meta, en la moneda de la cuenta.
 * Es el control principal del gasto: sin tope no se puede crear ni activar ningun anuncio desde la app.
 */
export async function setDailyCapAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("accounts.manage");
  if (!auth.ok) return { error: auth.error };

  const id = z.string().min(1).safeParse(formData.get("accountId"));
  if (!id.success) return { error: "Datos no válidos." };
  const account = await db.socialAccount.findUnique({
    where: { id: id.data },
    select: { name: true, platform: true, kind: true, currency: true, dailyBudgetCap: true },
  });
  if (!account || account.platform !== "META" || account.kind !== "AD_ACCOUNT") return { error: "Esa cuenta publicitaria no existe." };

  const raw = String(formData.get("cap") ?? "").trim();
  const before = account.dailyBudgetCap === null ? null : Number(account.dailyBudgetCap);

  if (raw === "") {
    await db.socialAccount.update({ where: { id: id.data }, data: { dailyBudgetCap: null } });
    await audit("ads.cap_cleared", { userId: auth.user.id, target: id.data, detail: { account: account.name, from: before } });
    refresh();
    return { success: "Se quitó el tope: no se podrán crear ni activar anuncios en esta cuenta hasta fijar uno." };
  }

  const decimals = budgetDecimals(account.currency);
  if (decimals === null) {
    return { error: `La moneda de esta cuenta (${account.currency ?? "desconocida"}) no está en la tabla de Meta: no se puede fijar un tope con seguridad.`, values: { cap: raw } };
  }
  const cap = parseBudgetInput(raw, account.currency);
  if (cap === null) {
    return {
      error: `No entendí «${raw}». Escribe el monto en ${account.currency} ${decimals === 0 ? "sin decimales (por ejemplo 50000 o 50.000)" : "con hasta 2 decimales (por ejemplo 10,50)"}, mayor que 0.`,
      values: { cap: raw },
    };
  }
  await db.socialAccount.update({ where: { id: id.data }, data: { dailyBudgetCap: cap } });
  await audit("ads.cap_set", { userId: auth.user.id, target: id.data, detail: { account: account.name, from: before, to: cap, currency: account.currency } });
  refresh();
  return { success: `Tope fijado en ${formatMoney(cap, account.currency ?? "")} por día.` };
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
