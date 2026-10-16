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
 * Fija (o quita) los topes de gasto de una cuenta publicitaria de Meta, en la moneda de la cuenta:
 *  - diario por anuncio: el control principal; sin el no se crea ni se activa nada;
 *  - mensual (opcional): suma lo gastado en el mes y lo comprometido; al llegar, los anuncios activos de la app se pausan.
 * Un campo vacio quita ese tope.
 */
export async function setSpendCapsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("accounts.manage");
  if (!auth.ok) return { error: auth.error };

  const id = z.string().min(1).safeParse(formData.get("accountId"));
  if (!id.success) return { error: "Datos no válidos." };
  const account = await db.socialAccount.findUnique({
    where: { id: id.data },
    select: { name: true, platform: true, kind: true, currency: true, dailyBudgetCap: true, monthlyBudgetCap: true },
  });
  if (!account || account.platform !== "META" || account.kind !== "AD_ACCOUNT") return { error: "Esa cuenta publicitaria no existe." };

  const rawDaily = String(formData.get("cap") ?? "").trim();
  const rawMonthly = String(formData.get("monthlyCap") ?? "").trim();
  const values = { cap: rawDaily, monthlyCap: rawMonthly };
  const dailyBefore = account.dailyBudgetCap === null ? null : Number(account.dailyBudgetCap);
  const monthlyBefore = account.monthlyBudgetCap === null ? null : Number(account.monthlyBudgetCap);

  const decimals = budgetDecimals(account.currency);
  if ((rawDaily !== "" || rawMonthly !== "") && decimals === null) {
    return { error: `La moneda de esta cuenta (${account.currency ?? "desconocida"}) no está en la tabla de Meta: no se puede fijar un tope con seguridad.`, values };
  }
  const how = decimals === 0 ? "sin decimales (por ejemplo 50000 o 50.000)" : "con hasta 2 decimales (por ejemplo 10,50)";
  const parse = (raw: string, label: string): { value: number | null } | { error: string } => {
    if (raw === "") return { value: null };
    const v = parseBudgetInput(raw, account.currency);
    return v === null ? { error: `No entendí «${raw}» en el tope ${label}. Escribe el monto en ${account.currency} ${how}, mayor que 0.` } : { value: v };
  };
  const daily = parse(rawDaily, "diario");
  if ("error" in daily) return { error: daily.error, values };
  const monthly = parse(rawMonthly, "mensual");
  if ("error" in monthly) return { error: monthly.error, values };
  if (daily.value !== null && monthly.value !== null && monthly.value < daily.value) {
    return { error: "El tope mensual no puede ser menor que el diario: un solo día ya lo pasaría.", values };
  }

  if (daily.value === dailyBefore && monthly.value === monthlyBefore) return { success: "Sin cambios." };
  await db.socialAccount.update({ where: { id: id.data }, data: { dailyBudgetCap: daily.value, monthlyBudgetCap: monthly.value } });

  const money = (v: number) => formatMoney(v, account.currency ?? "");
  const notes: string[] = [];
  if (daily.value !== dailyBefore) {
    await audit(daily.value === null ? "ads.cap_cleared" : "ads.cap_set", { userId: auth.user.id, target: id.data, detail: { account: account.name, from: dailyBefore, to: daily.value, currency: account.currency } });
    notes.push(daily.value === null ? "Se quitó el tope diario: no se podrán crear ni activar anuncios en esta cuenta hasta fijar uno." : `Tope diario fijado en ${money(daily.value)} por día.`);
  }
  if (monthly.value !== monthlyBefore) {
    await audit(monthly.value === null ? "ads.monthly_cap_cleared" : "ads.monthly_cap_set", { userId: auth.user.id, target: id.data, detail: { account: account.name, from: monthlyBefore, to: monthly.value, currency: account.currency } });
    notes.push(monthly.value === null ? "Se quitó el tope mensual." : `Tope mensual fijado en ${money(monthly.value)}.`);
  }
  refresh();
  return { success: notes.join(" ") };
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
