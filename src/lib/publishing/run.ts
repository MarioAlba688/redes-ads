import "server-only";
import { audit } from "@/lib/audit";
import { decryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { describeInternalError } from "@/lib/errors";
import { MISSING_IMAGE_MESSAGE, readImage } from "@/lib/media";
import { MetaApiError } from "@/lib/meta/errors";
import {
  backoffMinutes,
  classifyPublishError,
  MAX_PUBLISH_ATTEMPTS,
  PublishError,
  publicMediaUrl,
  publishToFacebookPage,
  publishToInstagram,
  type PublishImage,
} from "@/lib/meta/publish";
import { missingPublishScope, missingScopeMessage } from "@/lib/meta/scopes";
import { derivePostStatus, isTerminal } from "@/lib/publishing/status";

/** Un destino que lleva "publicandose" mas tiempo que esto se da por interrumpido (el proceso se cayo). */
const STALE_LOCK_MS = 10 * 60_000;
/** Cuantos destinos se procesan como maximo en cada vuelta. */
const BATCH = 20;

export type RunSummary = { published: number; failed: number; retrying: number; recovered: number };

/** Recalcula el estado de la publicacion segun sus destinos y lo guarda (sin pisar una cancelacion). */
export async function refreshPostStatus(postId: string, now = new Date()): Promise<void> {
  const targets = await db.postTarget.findMany({ where: { postId }, select: { status: true } });
  const next = derivePostStatus(targets);
  const result = await db.post.updateMany({
    where: { id: postId, status: { in: ["SCHEDULED", "PUBLISHING"] } },
    data: { status: next, ...(isTerminal(next) ? { publishedAt: next === "FAILED" ? null : now } : {}) },
  });
  if (result.count === 1 && isTerminal(next)) {
    await audit(`post.${next === "PUBLISHED" ? "published" : next === "PARTIAL" ? "partial" : "failed"}`, { target: postId });
  }
}

/** Destinos que quedaron "publicandose" y nunca terminaron: se marcan como fallidos en lugar de repetirlos a ciegas. */
async function recoverStale(now: Date): Promise<number> {
  const stale = await db.postTarget.findMany({
    where: { status: "PUBLISHING", lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) } },
    select: { id: true, postId: true },
  });
  let recovered = 0;
  for (const t of stale) {
    const r = await db.postTarget.updateMany({
      where: { id: t.id, status: "PUBLISHING" },
      data: {
        status: "FAILED",
        lockedAt: null,
        error: "El proceso se interrumpió mientras publicaba. Revisa en la red social si la publicación salió antes de reintentar.",
      },
    });
    if (r.count === 1) {
      recovered++;
      await refreshPostStatus(t.postId, now);
    }
  }
  return recovered;
}

type Outcome = "published" | "failed" | "retrying";

/** Publica un destino que ya esta reservado (PUBLISHING) y deja su resultado guardado. */
async function publishOne(targetId: string, now: Date): Promise<Outcome> {
  const target = await db.postTarget.findUnique({
    where: { id: targetId },
    include: {
      account: { select: { id: true, name: true, kind: true, externalId: true, status: true, accessTokenEnc: true, scopes: true } },
      post: { select: { id: true, text: true, linkUrl: true, status: true, media: { orderBy: { position: "asc" } } } },
    },
  });
  if (!target) return "failed";

  const fail = async (message: string, opts: { retry?: boolean } = {}): Promise<Outcome> => {
    const attempts = target.attempts + 1;
    const retry = opts.retry === true && attempts < MAX_PUBLISH_ATTEMPTS;
    await db.postTarget.update({
      where: { id: targetId },
      data: {
        status: retry ? "PENDING" : "FAILED",
        attempts,
        error: message,
        lockedAt: null,
        nextAttemptAt: retry ? new Date(now.getTime() + backoffMinutes(attempts) * 60_000) : null,
      },
    });
    await audit("post.target_failed", { target: target.post.id, detail: { account: target.account.name, retry, error: message.slice(0, 200) } });
    return retry ? "retrying" : "failed";
  };

  // Si alguien la cancelo justo despues de reservar el destino, no se publica.
  if (target.post.status === "CANCELLED") return fail("La publicación se canceló antes de publicarse.");
  if (target.account.status !== "ACTIVE" || !target.account.accessTokenEnc) {
    return fail("La cuenta está desconectada o su conexión con Meta venció. Reconecta Meta en Cuentas.");
  }
  // Si Meta no concedio el permiso de publicar, se sabe de antemano: no se gasta una llamada que va a fallar.
  const missing = missingPublishScope(target.account.kind, target.account.scopes);
  if (missing) return fail(missingScopeMessage(target.account.name, missing));

  try {
    const token = decryptSecret(target.account.accessTokenEnc);
    const images: PublishImage[] = [];
    for (const [i, media] of target.post.media.entries()) {
      const bytes = await readImage(media.storageKey);
      if (!bytes) throw new PublishError(target.post.media.length > 1 ? `La imagen ${i + 1}: ${MISSING_IMAGE_MESSAGE}` : MISSING_IMAGE_MESSAGE, false);
      images.push({
        bytes,
        mimeType: media.mimeType,
        filename: `imagen-${i + 1}.${media.mimeType === "image/png" ? "png" : "jpg"}`,
        // Solo Instagram la descarga por URL; Facebook recibe el archivo directamente.
        publicUrl: target.account.kind === "INSTAGRAM_PROFILE" ? publicMediaUrl(media.storageKey) : "",
      });
    }

    const input = { text: target.post.text, linkUrl: target.post.linkUrl, images };
    const account = { externalId: target.account.externalId, token };
    const result =
      target.account.kind === "INSTAGRAM_PROFILE" ? await publishToInstagram(account, input) : await publishToFacebookPage(account, input);

    await db.postTarget.update({
      where: { id: targetId },
      data: {
        status: "PUBLISHED",
        attempts: target.attempts + 1,
        externalId: result.externalId.slice(0, 191),
        externalUrl: result.url.slice(0, 500),
        publishedAt: now,
        error: null,
        lockedAt: null,
        nextAttemptAt: null,
      },
    });
    await audit("post.target_published", { target: target.post.id, detail: { account: target.account.name } });
    return "published";
  } catch (e) {
    if (!(e instanceof PublishError) && !(e instanceof MetaApiError)) {
      console.error("[publicar] error interno", target.account.id, describeInternalError(e));
    }
    const c = classifyPublishError(e);
    if (c.expired) {
      await db.socialAccount.updateMany({
        where: { id: target.account.id, status: "ACTIVE" },
        data: { status: "EXPIRED", lastError: c.message },
      });
    }
    return fail(c.message, { retry: c.retryable });
  }
}

/**
 * Publica lo que ya toca: destinos pendientes de publicaciones programadas cuya hora llego (y cuyo reintento,
 * si lo hay, ya vencio). Cada destino se reserva con una actualizacion condicional, asi que aunque corran dos
 * procesos a la vez ninguno publica el mismo dos veces. Nunca lanza.
 */
export async function runDuePublications(now = new Date()): Promise<RunSummary> {
  const summary: RunSummary = { published: 0, failed: 0, retrying: 0, recovered: 0 };
  try {
    summary.recovered = await recoverStale(now);

    const due = await db.postTarget.findMany({
      where: {
        status: "PENDING",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        post: { status: { in: ["SCHEDULED", "PUBLISHING"] }, scheduledAt: { lte: now } },
      },
      select: { id: true, postId: true },
      orderBy: { post: { scheduledAt: "asc" } },
      take: BATCH,
    });

    for (const t of due) {
      const claimed = await db.postTarget.updateMany({
        where: { id: t.id, status: "PENDING" },
        data: { status: "PUBLISHING", lockedAt: now },
      });
      if (claimed.count !== 1) continue; // otro proceso lo tomo primero
      await db.post.updateMany({ where: { id: t.postId, status: "SCHEDULED" }, data: { status: "PUBLISHING" } });

      const outcome = await publishOne(t.id, now);
      await refreshPostStatus(t.postId, now);
      if (outcome === "published") summary.published++;
      else if (outcome === "retrying") summary.retrying++;
      else summary.failed++;
    }
  } catch (e) {
    console.error("[publicar] fallo la vuelta", describeInternalError(e));
  }
  return summary;
}
