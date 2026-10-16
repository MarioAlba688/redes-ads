import "server-only";
import { decryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { describeInternalError } from "@/lib/errors";
import { MetaApiError } from "@/lib/meta/errors";
import { classifyStatsError, fetchFacebookPostMetrics, fetchInstagramMediaMetrics } from "@/lib/meta/post-metrics";
import { missingStatsMessage, missingStatsScopes } from "@/lib/meta/scopes";
import {
  EMPTY_METRICS,
  mergeMetrics,
  nextFetchAfter,
  retryAfterFailure,
  STATS_MAX_AGE_DAYS,
  type PostMetrics,
} from "@/lib/stats/metrics";

/** Cuantas publicaciones se leen como maximo en cada vuelta del proceso en segundo plano. */
const BATCH = 6;
/** Tiempo maximo de una vuelta: leer es lento y no debe retrasar las publicaciones que esperan su hora. */
const TIME_BUDGET_MS = 20_000;
/** Con «Actualizar» no se vuelve a leer lo que se leyo hace menos que esto. */
const MIN_AGE_MS = 2 * 60_000;
const DAY_MS = 86_400_000;

export type RefreshOutcome = "ok" | "partial" | "failed" | "skipped";
export type RefreshResult = { outcome: RefreshOutcome; message?: string };

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "P2002" || /unique constraint|duplicate entry/i.test(String((e as Error | null)?.message ?? ""));
}

type Row = {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
} | null;

const asMetrics = (row: Row): PostMetrics | null =>
  row && { views: row.views, reach: row.reach, likes: row.likes, comments: row.comments, shares: row.shares, saves: row.saves };

/** Guarda una lectura: actualiza la fila de la publicacion o la crea (dos procesos a la vez no se pisan: el segundo actualiza). */
async function saveReading(
  targetId: string,
  data: { metrics: PostMetrics; note: string | null; nextFetchAt: Date | null; fetchedAt: Date },
): Promise<void> {
  const fields = { ...data.metrics, note: data.note, nextFetchAt: data.nextFetchAt, fetchedAt: data.fetchedAt };
  const updated = await db.postTargetMetrics.updateMany({ where: { targetId }, data: fields });
  if (updated.count > 0) return;
  try {
    await db.postTargetMetrics.create({ data: { targetId, ...fields } });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    await db.postTargetMetrics.updateMany({ where: { targetId }, data: fields });
  }
}

/** Anota un fallo sin tocar las cifras ya guardadas ni la fecha de la ultima lectura buena. */
async function saveFailure(targetId: string, existing: boolean, note: string, nextFetchAt: Date | null, now: Date): Promise<void> {
  if (existing) {
    const r = await db.postTargetMetrics.updateMany({ where: { targetId }, data: { note, nextFetchAt } });
    if (r.count > 0) return;
  }
  await saveReading(targetId, { metrics: EMPTY_METRICS, note, nextFetchAt, fetchedAt: now });
}

/**
 * Lee las estadisticas de un destino ya publicado y las guarda. Nunca lanza. Si Meta no entrega algo, se conserva lo
 * anterior y se anota que falto; una conexion vencida deja la cuenta como «Vencida», igual que al publicar.
 */
export async function refreshTargetMetrics(targetId: string, now = new Date()): Promise<RefreshResult> {
  try {
    const target = await db.postTarget.findUnique({
      where: { id: targetId },
      select: {
        status: true,
        externalId: true,
        publishedAt: true,
        metrics: true,
        account: { select: { id: true, name: true, kind: true, externalId: true, status: true, accessTokenEnc: true, scopes: true } },
      },
    });
    if (!target || target.status !== "PUBLISHED" || !target.externalId) return { outcome: "skipped" };
    const account = target.account;
    if (account.kind !== "FACEBOOK_PAGE" && account.kind !== "INSTAGRAM_PROFILE") return { outcome: "skipped" };
    if (account.status !== "ACTIVE" || !account.accessTokenEnc) {
      return { outcome: "skipped", message: `La cuenta «${account.name}» está desconectada o su conexión venció. Reconecta Meta en Cuentas.` };
    }

    const previous = asMetrics(target.metrics);
    const exists = target.metrics !== null;
    const publishedAt = target.publishedAt ?? now;
    const missing = missingStatsScopes(account.kind, account.scopes);

    // Si Meta no concedio ni el permiso basico, se sabe de antemano: no se gasta una llamada que va a fallar.
    if (missing.basic) {
      const note = missingStatsMessage(account.name, missing.basic, "basic");
      await saveFailure(targetId, exists, note, retryAfterFailure("permission", now), now);
      return { outcome: "failed", message: note };
    }

    try {
      const token = decryptSecret(account.accessTokenEnc);
      const ref = { externalId: account.externalId, token };
      const options = { insights: missing.insights === null };
      const fetched =
        account.kind === "INSTAGRAM_PROFILE"
          ? await fetchInstagramMediaMetrics(ref, target.externalId, options)
          : await fetchFacebookPostMetrics(ref, target.externalId, options);

      const notes = [...fetched.notes];
      if (missing.insights) notes.push(missingStatsMessage(account.name, missing.insights, "insights"));
      const note = notes.length ? notes.join(" ") : null;
      await saveReading(targetId, {
        metrics: mergeMetrics(fetched.metrics, previous),
        note,
        // Si una parte fallo por algo pasajero se reintenta pronto; si no, segun la edad de la publicacion.
        nextFetchAt: fetched.transient ? retryAfterFailure("network", now) : nextFetchAfter(publishedAt, now),
        fetchedAt: now,
      });
      return { outcome: note ? "partial" : "ok", message: note ?? undefined };
    } catch (e) {
      if (!(e instanceof MetaApiError)) console.error("[estadisticas] error interno", account.id, describeInternalError(e));
      const c = classifyStatsError(e, account.kind);
      if (c.kind === "expired") {
        await db.socialAccount.updateMany({ where: { id: account.id, status: "ACTIVE" }, data: { status: "EXPIRED", lastError: c.message } });
      }
      await saveFailure(targetId, exists, c.message, retryAfterFailure(c.kind, now), now);
      return { outcome: "failed", message: c.message };
    }
  } catch (e) {
    console.error("[estadisticas] fallo al leer un destino", describeInternalError(e));
    return { outcome: "failed", message: "No se pudo guardar la lectura. Revisa los registros del servidor." };
  }
}

/**
 * Lee lo que ya toca: destinos publicados (hasta 90 dias atras) que nunca se leyeron o cuya proxima lectura ya llego,
 * los mas nuevos primero. Respeta un tiempo maximo para no retrasar las publicaciones del mismo proceso. Nunca lanza.
 */
export async function refreshDueMetrics(now = new Date(), opts: { limit?: number; budgetMs?: number } = {}): Promise<{ refreshed: number; failed: number }> {
  const summary = { refreshed: 0, failed: 0 };
  try {
    const due = await db.postTarget.findMany({
      where: {
        status: "PUBLISHED",
        externalId: { not: null },
        publishedAt: { gte: new Date(now.getTime() - STATS_MAX_AGE_DAYS * DAY_MS) },
        account: { platform: "META", status: "ACTIVE", accessTokenEnc: { not: null }, kind: { in: ["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"] } },
        OR: [{ metrics: { is: null } }, { metrics: { is: { nextFetchAt: { lte: now } } } }],
      },
      select: { id: true },
      orderBy: { publishedAt: "desc" },
      take: opts.limit ?? BATCH,
    });

    const started = Date.now();
    for (const t of due) {
      if (Date.now() - started > (opts.budgetMs ?? TIME_BUDGET_MS)) break;
      const r = await refreshTargetMetrics(t.id, now);
      if (r.outcome === "ok" || r.outcome === "partial") summary.refreshed++;
      else if (r.outcome === "failed") summary.failed++;
    }
  } catch (e) {
    console.error("[estadisticas] fallo la vuelta", describeInternalError(e));
  }
  return summary;
}

/**
 * Lectura pedida a mano («Actualizar»): vuelve a leer esos destinos aunque no les toque, salvo los leidos hace menos
 * de 2 minutos (evita golpear a Meta con clics repetidos).
 */
export async function refreshTargetsNow(
  targetIds: string[],
  now = new Date(),
): Promise<{ refreshed: number; failed: number; skipped: number; firstProblem: string | null }> {
  const out = { refreshed: 0, failed: 0, skipped: 0, firstProblem: null as string | null };
  const recent = await db.postTargetMetrics.findMany({
    where: { targetId: { in: targetIds }, fetchedAt: { gt: new Date(now.getTime() - MIN_AGE_MS) }, note: null },
    select: { targetId: true },
  });
  const fresh = new Set(recent.map((r) => r.targetId));

  for (const id of targetIds) {
    if (fresh.has(id)) {
      out.skipped++;
      continue;
    }
    const r = await refreshTargetMetrics(id, now);
    if (r.outcome === "ok" || r.outcome === "partial") out.refreshed++;
    else if (r.outcome === "failed") out.failed++;
    else out.skipped++;
    if (!out.firstProblem && r.message) out.firstProblem = r.message;
  }
  return out;
}
