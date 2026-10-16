import "server-only";
import { audit } from "@/lib/audit";
import * as meta from "@/lib/meta/marketing";
import { toMinorUnits } from "@/lib/promotions/currency";
import { activationCapError, budgetHolder, type ExistingLevel } from "@/lib/promotions/existing";
import { failureMessage, loadAdAccount, type LoadedAccount, type Result } from "@/lib/promotions/service";

// Administrar lo que YA existe en una cuenta publicitaria (lo creado en Meta o en la app): ver, pausar, activar y
// cambiar el presupuesto diario. Las mismas protecciones que al crear: nada se activa por encima del tope. Quien llama
// (las acciones del servidor) comprueba antes los permisos de la persona.

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export type ExistingView = { account: LoadedAccount; objects: meta.AccountObjects };

/** Lee de Meta lo que hay en la cuenta publicitaria. Con `write: false` (solo mirar) no exige ads_management. */
export async function loadExisting(adAccountId: string, opts: { write?: boolean } = {}): Promise<Result<ExistingView>> {
  const a = await loadAdAccount(adAccountId, { write: opts.write });
  if (!a.ok) return a;
  try {
    return { ok: true, account: a.account, objects: await meta.listAccountObjects(a.account.auth) };
  } catch (e) {
    return fail(await failureMessage(e, a.account.id, "listar"));
  }
}

const present = (objects: meta.AccountObjects, level: ExistingLevel, id: string) =>
  (level === "campaign" ? objects.campaigns : level === "adset" ? objects.adSets : objects.ads).some((o) => o.id === id);

const NAMES: Record<ExistingLevel, string> = { campaign: "la campaña", adset: "el conjunto de anuncios", ad: "el anuncio" };

/** Activa o pausa una campaña, un conjunto de anuncios o un anuncio de la cuenta. Activar comprueba el tope diario. */
export async function setExistingStatus(
  actorId: string,
  adAccountId: string,
  level: ExistingLevel,
  objectId: string,
  status: "ACTIVE" | "PAUSED",
): Promise<Result> {
  const view = await loadExisting(adAccountId);
  if (!view.ok) return view;
  const { account, objects } = view;
  if (!present(objects, level, objectId)) {
    return fail(`No se encontró ${NAMES[level]} en la cuenta${objects.truncated ? " (la cuenta tiene muchos objetos y solo se leen los primeros)" : ""}.`);
  }
  if (status === "ACTIVE") {
    const problem = activationCapError(objects, level, objectId, { currency: account.currency, cap: account.cap });
    if (problem) return fail(problem);
  }
  try {
    await meta.setStatus(account.auth.token, objectId, status);
    await audit(status === "ACTIVE" ? "ads.existing_activated" : "ads.existing_paused", { userId: actorId, target: objectId, detail: { level, account: account.name } });
    return { ok: true };
  } catch (e) {
    return fail(await failureMessage(e, account.id, "cambiar estado"));
  }
}

/** Cambia el presupuesto diario de una campaña o conjunto de la cuenta (sin pasar del tope) y comprueba que Meta lo guardo igual. */
export async function setExistingBudget(actorId: string, adAccountId: string, level: ExistingLevel, objectId: string, newBudget: number): Promise<Result> {
  const view = await loadExisting(adAccountId);
  if (!view.ok) return view;
  const { account, objects } = view;
  const holder = budgetHolder(objects, level, objectId);
  if ("reason" in holder) return fail(holder.reason);

  const minor = toMinorUnits(newBudget, account.currency);
  if (minor === null) return fail(`El presupuesto no es válido para ${account.currency} (mayor que 0 y con los decimales que admite la moneda).`);
  if (account.cap === null) return fail("Esta cuenta publicitaria todavía no tiene un tope de gasto diario. Pídele al administrador que lo fije en Cuentas.");
  if (newBudget > account.cap) return fail(`El presupuesto (${newBudget} ${account.currency}) supera el tope de esta cuenta (${account.cap} ${account.currency}).`);

  try {
    await meta.setDailyBudget(account.auth.token, holder.id, minor);
    const saved = await meta.readDailyBudget(account.auth.token, holder.id);
    if (saved !== minor) {
      return fail(`Meta registró un presupuesto distinto del pedido (${saved ?? "ninguno"} en lugar de ${minor}). Revísalo en Meta.`);
    }
    await audit("ads.existing_budget_changed", { userId: actorId, target: holder.id, detail: { level: holder.level, account: account.name, to: newBudget, currency: account.currency } });
    return { ok: true };
  } catch (e) {
    return fail(await failureMessage(e, account.id, "cambiar presupuesto"));
  }
}
