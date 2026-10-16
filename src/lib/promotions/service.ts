import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import { decryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { describeInternalError } from "@/lib/errors";
import { readImage } from "@/lib/media";
import * as meta from "@/lib/meta/marketing";
import { missingAdsWriteMessage, missingAdsWriteScope } from "@/lib/meta/scopes";
import { fromMinorUnits, toMinorUnits } from "@/lib/promotions/currency";
import { classifyAdsError } from "@/lib/promotions/errors";
import { facebookBoostCreativeBody, instagramBoostCreativeBody, newAdCreativeBody } from "@/lib/promotions/mapping";
import { statusFromMeta } from "@/lib/promotions/status";
import { buildMetaTargeting } from "@/lib/promotions/targeting";
import type { CtaType, PromotionInput, PromotionObjectiveName, Targeting } from "@/lib/promotions/types";
import { validatePromotion } from "@/lib/promotions/validate";

// Crear, activar, pausar y administrar anuncios en Meta. AQUI viven las protecciones del dinero:
//  - todo se crea en pausa y se COMPRUEBA con Meta que quedo en pausa y con el presupuesto pedido (un presupuesto mal
//    convertido o algo activo se borra y se avisa, no se deja);
//  - sin tope diario fijado por el administrador no se crea ni se activa nada, y el tope se vuelve a comprobar al activar
//    con lo que Meta tenga en ese momento;
//  - si la creacion falla a medias, lo que ya se creo en Meta se borra.
// Las funciones NO comprueban permisos de la persona: quien las llama (las acciones del servidor) lo hace antes.

export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Una comprobacion de seguridad fallo: se muestra tal cual a la persona. */
class SafetyError extends Error {}

const DAY_MS = 86_400_000;
/** Una creacion «en curso» mas vieja que esto se da por interrumpida. */
const STALE_CREATING_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Cuenta publicitaria
// ---------------------------------------------------------------------------

export type LoadedAccount = { id: string; name: string; auth: meta.AdAuth; currency: string; cap: number | null };

/**
 * Carga la cuenta publicitaria y su token. Con `write` (lo normal) exige tambien el permiso ads_management; para solo
 * LEER lo que hay en la cuenta basta ads_read, que es lo que tiene cualquier conexion de Meta.
 */
export async function loadAdAccount(adAccountId: string, opts: { write?: boolean } = {}): Promise<Result<{ account: LoadedAccount }>> {
  const a = await db.socialAccount.findUnique({
    where: { id: adAccountId },
    select: { id: true, name: true, platform: true, kind: true, externalId: true, status: true, accessTokenEnc: true, scopes: true, currency: true, dailyBudgetCap: true, metadata: true },
  });
  if (!a || a.platform !== "META" || a.kind !== "AD_ACCOUNT") return fail("Esa cuenta publicitaria no existe.");
  if (a.status !== "ACTIVE" || !a.accessTokenEnc) return fail(`La conexión de «${a.name}» venció o está desconectada. Reconecta Meta en Cuentas.`);
  if (opts.write !== false && missingAdsWriteScope(a.scopes)) return fail(missingAdsWriteMessage(a.name));
  const state = (a.metadata as { accountStatus?: unknown } | null)?.accountStatus;
  if (typeof state === "number" && state !== 1) {
    return fail(`La cuenta publicitaria «${a.name}» no está activa en Meta (estado ${state}). Revisa en Meta si tiene un pago pendiente o está deshabilitada.`);
  }
  if (!a.currency) return fail(`No se conoce la moneda de «${a.name}». Sincroniza la cuenta en Cuentas.`);
  let token: string;
  try {
    token = decryptSecret(a.accessTokenEnc);
  } catch {
    return fail(`No se pudo leer la conexión de «${a.name}». Reconecta Meta en Cuentas.`);
  }
  return { ok: true, account: { id: a.id, name: a.name, auth: { accountId: a.externalId, token }, currency: a.currency, cap: a.dailyBudgetCap === null ? null : Number(a.dailyBudgetCap) } };
}

export async function markExpired(accountId: string, message: string) {
  await db.socialAccount.updateMany({ where: { id: accountId, status: "ACTIVE" }, data: { status: "EXPIRED", lastError: message } });
}

/** Mensaje para la persona de cualquier fallo; si la conexion murio, deja la cuenta como vencida. */
export async function failureMessage(e: unknown, accountId: string, context: string): Promise<string> {
  if (e instanceof SafetyError) return e.message;
  if (!(e instanceof Error) || e.name !== "MetaApiError") console.error(`[anuncios] ${context}`, describeInternalError(e));
  const c = classifyAdsError(e);
  if (c.expired) await markExpired(accountId, c.message);
  return c.message;
}

const pageIdOf = (metadata: unknown): string | null => {
  const id = (metadata as { pageId?: unknown } | null)?.pageId;
  return typeof id === "string" && id ? id : null;
};

// ---------------------------------------------------------------------------
// Crear (siempre en pausa)
// ---------------------------------------------------------------------------

export type CreateRequest = {
  adAccountId: string;
  source: { kind: "BOOST"; targetId: string } | { kind: "AD"; postId: string; pageAccountId: string };
  objective: PromotionObjectiveName;
  name: string;
  dailyBudget: number;
  durationDays: number;
  targeting: Targeting;
  /** Texto, titular, enlace y boton. En un impulso se ignora: la publicacion ya los tiene. */
  creative: { message: string; headline: string | null; link: string | null; cta: CtaType | null };
};

type Resolved = {
  kind: "BOOST" | "AD";
  brandId: string;
  postId: string;
  targetId: string | null;
  /** Texto que se guarda de copia (lo que se ve en las listas). */
  message: string;
  pageId: string;
  instagramUserId: string | null;
  /** Un impulso de una publicacion de Instagram. */
  instagramBoost: { mediaId: string } | null;
  facebookPostId: string | null;
  image: { key: string; mimeType: string } | null;
};

async function resolveSource(req: CreateRequest): Promise<Result<{ resolved: Resolved }>> {
  if (req.source.kind === "BOOST") {
    const t = await db.postTarget.findUnique({
      where: { id: req.source.targetId },
      select: {
        id: true,
        status: true,
        externalId: true,
        account: { select: { kind: true, name: true, externalId: true, metadata: true } },
        post: { select: { id: true, brandId: true, text: true } },
      },
    });
    if (!t || t.status !== "PUBLISHED" || !t.externalId) return fail("Solo se pueden impulsar publicaciones que ya están publicadas.");
    const common = { kind: "BOOST" as const, brandId: t.post.brandId, postId: t.post.id, targetId: t.id, message: t.post.text, image: null };
    if (t.account.kind === "FACEBOOK_PAGE") {
      return { ok: true, resolved: { ...common, pageId: t.account.externalId, instagramUserId: null, instagramBoost: null, facebookPostId: t.externalId } };
    }
    if (t.account.kind === "INSTAGRAM_PROFILE") {
      const pageId = pageIdOf(t.account.metadata);
      if (!pageId) return fail(`No se sabe a qué página de Facebook está vinculada «${t.account.name}». Reconecta Meta en Cuentas.`);
      return { ok: true, resolved: { ...common, pageId, instagramUserId: t.account.externalId, instagramBoost: { mediaId: t.externalId }, facebookPostId: null } };
    }
    return fail("Ese destino no se puede impulsar.");
  }

  const post = await db.post.findUnique({
    where: { id: req.source.postId },
    select: { id: true, brandId: true, status: true, media: { orderBy: { position: "asc" }, take: 1, select: { storageKey: true, mimeType: true } } },
  });
  if (!post || post.status === "CANCELLED") return fail("Esa publicación no existe o está cancelada.");
  const page = await db.socialAccount.findUnique({ where: { id: req.source.pageAccountId }, select: { id: true, kind: true, status: true, brandId: true, externalId: true, name: true } });
  if (!page || page.kind !== "FACEBOOK_PAGE" || page.status !== "ACTIVE") return fail("Elige una página de Facebook conectada para publicar el anuncio.");
  if (page.brandId !== post.brandId) return fail(`La página «${page.name}» no es de la marca de esta publicación.`);
  // La cuenta de Instagram vinculada a esa pagina (si la hay) da al anuncio la identidad de Instagram.
  const igCandidates = await db.socialAccount.findMany({
    where: { platform: "META", kind: "INSTAGRAM_PROFILE", status: "ACTIVE", brandId: post.brandId },
    select: { externalId: true, metadata: true },
  });
  const ig = igCandidates.find((c) => pageIdOf(c.metadata) === page.externalId);
  const media = post.media[0] ?? null;
  return {
    ok: true,
    resolved: {
      kind: "AD",
      brandId: post.brandId,
      postId: post.id,
      targetId: null,
      message: req.creative.message,
      pageId: page.externalId,
      instagramUserId: ig?.externalId ?? null,
      instagramBoost: null,
      facebookPostId: null,
      image: media ? { key: media.storageKey, mimeType: media.mimeType } : null,
    },
  };
}

/** Borra de Meta lo creado (campaña, conjunto, anuncio). Devuelve los ids que NO se pudieron borrar. */
async function rollback(token: string, ids: (string | null)[]): Promise<string[]> {
  const left: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    try {
      await meta.setStatus(token, id, "DELETED");
    } catch {
      left.push(id);
    }
  }
  return left;
}

/**
 * Crea el anuncio en Meta: campaña, conjunto de anuncios, creativo y anuncio, TODO en pausa, y lo registra. Antes de
 * dar por bueno el resultado lo verifica contra Meta (presupuesto y pausa); si algo no cuadra, lo borra.
 */
export async function createPromotion(actorId: string, req: CreateRequest, now = new Date()): Promise<Result<{ id: string }>> {
  const loaded = await loadAdAccount(req.adAccountId);
  if (!loaded.ok) return loaded;
  const { account } = loaded;

  const src = await resolveSource(req);
  if (!src.ok) return src;
  const r = src.resolved;

  const input: PromotionInput = {
    kind: r.kind,
    objective: req.objective,
    name: req.name.trim(),
    dailyBudget: req.dailyBudget,
    durationDays: req.durationDays,
    targeting: req.targeting,
    creative: { message: r.message, headline: req.creative.headline?.trim() || null, link: req.creative.link?.trim() || null, cta: req.creative.cta, imageKey: r.image?.key ?? null },
  };
  const errors = validatePromotion(input, { currency: account.currency, cap: account.cap, hasImage: r.kind === "BOOST" ? undefined : r.image !== null });
  if (errors.length) return fail(errors.join("\n"));
  const dailyMinor = toMinorUnits(input.dailyBudget, account.currency);
  if (dailyMinor === null) return fail("No se pudo calcular el presupuesto en la moneda de la cuenta.");

  // Evita crear dos veces lo mismo con un doble clic: una creacion reciente de la misma persona para la misma publicacion sigue en curso.
  const inProgress = await db.adPromotion.count({
    where: {
      status: "CREATING",
      createdById: actorId,
      createdAt: { gt: new Date(now.getTime() - STALE_CREATING_MS) },
      ...(r.targetId ? { targetId: r.targetId } : { postId: r.postId }),
    },
  });
  if (inProgress > 0) return fail("Ya se está creando un anuncio para esta publicación. Espera a que termine.");

  const row = await db.adPromotion.create({
    data: {
      kind: r.kind,
      name: input.name,
      objective: input.objective,
      status: "CREATING",
      adAccountId: account.id,
      brandId: r.brandId,
      postId: r.postId,
      targetId: r.targetId,
      dailyBudget: input.dailyBudget,
      currency: account.currency,
      durationDays: input.durationDays,
      targeting: input.targeting as unknown as Prisma.InputJsonValue,
      creative: { message: r.message, headline: input.creative.headline, link: input.creative.link, cta: input.creative.cta, imageKey: r.image?.key ?? null } as Prisma.InputJsonValue,
      createdById: actorId,
    },
    select: { id: true },
  });

  const { auth } = account;
  const ids: { campaign: string | null; adSet: string | null; creative: string | null; ad: string | null } = { campaign: null, adSet: null, creative: null, ad: null };
  const save = (data: Prisma.AdPromotionUpdateInput) => db.adPromotion.update({ where: { id: row.id }, data });

  try {
    ids.campaign = await meta.createCampaign(auth, input.name, input.objective);
    await save({ metaCampaignId: ids.campaign });

    // Cuando termina: un poco despues de lo previsto. Al activarlo se fija el fin exacto (la duracion cuenta desde ahi).
    const provisionalEnd = new Date(now.getTime() + (input.durationDays + 1) * DAY_MS);
    ids.adSet = await meta.createAdSet(auth, {
      name: input.name,
      campaignId: ids.campaign,
      objective: input.objective,
      dailyBudgetMinor: dailyMinor,
      endsAt: provisionalEnd,
      targeting: buildMetaTargeting(input.targeting, { instagramOnly: r.instagramBoost !== null }),
      pageId: r.pageId,
    });
    await save({ metaAdSetId: ids.adSet });

    if (r.kind === "BOOST") {
      const body = r.instagramBoost
        ? instagramBoostCreativeBody(input.name, { pageId: r.pageId, instagramUserId: r.instagramUserId as string, mediaId: r.instagramBoost.mediaId })
        : facebookBoostCreativeBody(input.name, r.facebookPostId as string);
      ids.creative = await meta.createCreative(auth, body);
    } else {
      const bytes = r.image ? await readImage(r.image.key) : null;
      if (!r.image || !bytes) throw new SafetyError("No se encontró el archivo de la imagen en el servidor.");
      const ext = r.image.mimeType === "image/png" ? "png" : "jpg";
      const hash = await meta.uploadAdImage(auth, { bytes, filename: `anuncio.${ext}`, mimeType: r.image.mimeType });
      ids.creative = await meta.createCreative(
        auth,
        newAdCreativeBody({
          name: input.name,
          pageId: r.pageId,
          instagramUserId: r.instagramUserId,
          imageHash: hash,
          message: input.creative.message,
          headline: input.creative.headline,
          link: input.creative.link,
          cta: input.creative.cta,
        }),
      );
    }
    await save({ metaCreativeId: ids.creative });

    ids.ad = await meta.createAd(auth, input.name, ids.adSet, ids.creative);
    await save({ metaAdId: ids.ad });

    // --- verificacion contra Meta: lo que quedo creado es lo que se pidio, y en pausa ---
    const adSet = await meta.readAdSet(auth.token, ids.adSet);
    if (adSet.dailyBudgetMinor !== dailyMinor) {
      throw new SafetyError(
        `Meta registró un presupuesto diario de ${adSet.dailyBudgetMinor ?? "ninguno"} (en la unidad mínima de ${account.currency}) y se pidió ${dailyMinor}. Por seguridad se canceló la creación. Avisa a quien administra la app.`,
      );
    }
    const states = await Promise.all([ids.campaign, ids.adSet, ids.ad].map((id) => meta.readStatus(auth.token, id)));
    if (states.some((s) => s.status !== "PAUSED")) {
      throw new SafetyError("Meta no dejó el anuncio en pausa. Por seguridad se canceló la creación. Avisa a quien administra la app.");
    }

    await save({ status: "PAUSED", effectiveStatus: states[2].effectiveStatus, lastSyncedAt: now, error: null });
    await audit("ads.created", {
      userId: actorId,
      target: row.id,
      detail: { kind: r.kind, objective: input.objective, dailyBudget: input.dailyBudget, currency: account.currency, days: input.durationDays, account: account.name },
    });
    return { ok: true, id: row.id };
  } catch (e) {
    const message = await failureMessage(e, account.id, "crear");
    const left = await rollback(auth.token, [ids.ad, ids.adSet, ids.campaign]);
    const note = left.length ? ` Algo quedó creado en Meta y no se pudo borrar (ids ${left.join(", ")}): revísalo en el Administrador de anuncios; está en pausa.` : "";
    await db.adPromotion.update({
      where: { id: row.id },
      data: { status: "FAILED", error: `${message}${note}`.slice(0, 2000), ...(left.length ? {} : { metaCampaignId: null, metaAdSetId: null, metaCreativeId: null, metaAdId: null }) },
    });
    await audit("ads.create_failed", { userId: actorId, target: row.id, detail: { error: message.slice(0, 200) } });
    return fail(`${message}${note}`);
  }
}

// ---------------------------------------------------------------------------
// Activar, pausar, presupuesto, archivar
// ---------------------------------------------------------------------------

type Loaded = {
  row: { id: string; status: string; name: string; dailyBudget: Prisma.Decimal; currency: string; durationDays: number; metaCampaignId: string | null; metaAdSetId: string | null; metaAdId: string | null; adAccountId: string };
  account: LoadedAccount;
};

async function loadPromotion(id: string): Promise<Result<Loaded>> {
  const row = await db.adPromotion.findUnique({
    where: { id },
    select: { id: true, status: true, name: true, dailyBudget: true, currency: true, durationDays: true, metaCampaignId: true, metaAdSetId: true, metaAdId: true, adAccountId: true },
  });
  if (!row) return fail("Ese anuncio ya no existe.");
  const a = await loadAdAccount(row.adAccountId);
  if (!a.ok) return a;
  return { ok: true, row, account: a.account };
}

const metaIds = (row: Loaded["row"]) => [row.metaCampaignId, row.metaAdSetId, row.metaAdId];

/**
 * Activa el anuncio (campaña, conjunto y anuncio). Vuelve a comprobar el tope con el presupuesto que Meta tiene EN ESTE
 * MOMENTO (alguien pudo cambiarlo en Meta) y fija el fin exacto: la duracion cuenta desde que se activa.
 */
export async function activatePromotion(actorId: string, id: string, now = new Date()): Promise<Result> {
  const loaded = await loadPromotion(id);
  if (!loaded.ok) return loaded;
  const { row, account } = loaded;
  if (row.status !== "PAUSED") return fail(row.status === "ACTIVE" ? "Este anuncio ya está activo." : "Solo se puede activar un anuncio que esté en pausa.");
  const [campaignId, adSetId, adId] = metaIds(row);
  if (!campaignId || !adSetId || !adId) return fail("A este anuncio le falta algo que crear en Meta: no se puede activar.");
  const { token } = account.auth;

  const endsAt = new Date(now.getTime() + row.durationDays * DAY_MS);
  const done: string[] = [];
  try {
    const adSet = await meta.readAdSet(token, adSetId);
    if (adSet.lifetimeBudgetMinor) return fail("El conjunto de anuncios tiene un presupuesto total y no uno diario: no se puede comprobar contra el tope. Revísalo en Meta.");
    const dailyNow = fromMinorUnits(adSet.dailyBudgetMinor, account.currency);
    if (dailyNow === null) return fail("No se pudo leer el presupuesto actual en Meta. Inténtalo de nuevo.");
    if (account.cap === null) return fail("Esta cuenta publicitaria todavía no tiene un tope de gasto diario. Pídele al administrador que lo fije en Cuentas.");
    if (dailyNow > account.cap) {
      return fail(`En Meta el presupuesto diario es ${dailyNow} ${account.currency}, por encima del tope de la cuenta (${account.cap} ${account.currency}). Bájalo antes de activar.`);
    }

    await meta.setAdSetEnd(token, adSetId, endsAt);
    for (const target of [campaignId, adSetId, adId]) {
      await meta.setStatus(token, target, "ACTIVE");
      done.push(target);
    }
    const ad = await meta.readStatus(token, adId);
    await db.adPromotion.update({
      where: { id },
      data: { status: "ACTIVE", activatedAt: now, endsAt, activatedById: actorId, effectiveStatus: ad.effectiveStatus, lastSyncedAt: now, error: null },
    });
    await audit("ads.activated", { userId: actorId, target: id, detail: { name: row.name, dailyBudget: dailyNow, currency: account.currency, endsAt: endsAt.toISOString() } });
    return { ok: true };
  } catch (e) {
    // Lo que se alcanzo a activar se vuelve a pausar: nunca queda activo a medias.
    await rollbackToPaused(token, done);
    return fail(await failureMessage(e, account.id, "activar"));
  }
}

/** Vuelve a pausar lo que se activo, en orden inverso al de activacion (anuncio, conjunto, campaña). Devuelve lo que no se pudo. */
async function rollbackToPaused(token: string, ids: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const id of [...ids].reverse()) {
    try {
      await meta.setStatus(token, id, "PAUSED");
    } catch {
      left.push(id);
    }
  }
  return left;
}

/** Pausa el anuncio (anuncio, conjunto y campaña). Pausar nunca gasta: puede hacerlo quien lo crea y quien lo aprueba. */
export async function pausePromotion(actorId: string, id: string, now = new Date()): Promise<Result> {
  const loaded = await loadPromotion(id);
  if (!loaded.ok) return loaded;
  const { row, account } = loaded;
  if (row.status !== "ACTIVE" && row.status !== "PAUSED") return fail("Este anuncio no se puede pausar.");
  const { token } = account.auth;
  try {
    const left = await rollbackToPaused(token, [row.metaCampaignId, row.metaAdSetId, row.metaAdId].filter((x): x is string => !!x));
    if (left.length) return fail("No se pudo pausar todo en Meta. Inténtalo de nuevo (si insiste, pausa el anuncio directamente en Meta).");
    await db.adPromotion.update({ where: { id }, data: { status: "PAUSED", lastSyncedAt: now } });
    await audit("ads.paused", { userId: actorId, target: id, detail: { name: row.name } });
    return { ok: true };
  } catch (e) {
    return fail(await failureMessage(e, account.id, "pausar"));
  }
}

/** Cambia el presupuesto diario (sin pasar del tope) y comprueba con Meta que quedo como se pidio. */
export async function changePromotionBudget(actorId: string, id: string, newBudget: number, now = new Date()): Promise<Result> {
  const loaded = await loadPromotion(id);
  if (!loaded.ok) return loaded;
  const { row, account } = loaded;
  if (row.status !== "ACTIVE" && row.status !== "PAUSED") return fail("Solo se puede cambiar el presupuesto de un anuncio activo o en pausa.");
  if (!row.metaAdSetId) return fail("A este anuncio le falta algo que crear en Meta.");
  const minor = toMinorUnits(newBudget, account.currency);
  if (minor === null) return fail(`El presupuesto no es válido para ${account.currency} (mayor que 0 y con los decimales que admite la moneda).`);
  if (account.cap === null) return fail("Esta cuenta publicitaria todavía no tiene un tope de gasto diario. Pídele al administrador que lo fije en Cuentas.");
  if (newBudget > account.cap) return fail(`El presupuesto (${newBudget} ${account.currency}) supera el tope de esta cuenta (${account.cap} ${account.currency}).`);
  const { token } = account.auth;
  try {
    await meta.setDailyBudget(token, row.metaAdSetId, minor);
    const check = await meta.readAdSet(token, row.metaAdSetId);
    if (check.dailyBudgetMinor !== minor) {
      throw new SafetyError(`Meta registró un presupuesto distinto del pedido (${check.dailyBudgetMinor ?? "ninguno"} en lugar de ${minor}). Revisa el anuncio en Meta.`);
    }
    await db.adPromotion.update({ where: { id }, data: { dailyBudget: newBudget, lastSyncedAt: now } });
    await audit("ads.budget_changed", { userId: actorId, target: id, detail: { name: row.name, from: Number(row.dailyBudget), to: newBudget, currency: account.currency } });
    return { ok: true };
  } catch (e) {
    return fail(await failureMessage(e, account.id, "cambiar presupuesto"));
  }
}

/** Archiva el anuncio en Meta (conserva sus cifras) y lo saca de la gestion. Si estaba activo, antes lo pausa. */
export async function archivePromotion(actorId: string, id: string, now = new Date()): Promise<Result> {
  const loaded = await loadPromotion(id);
  if (!loaded.ok) return loaded;
  const { row, account } = loaded;
  if (row.status === "ARCHIVED") return fail("Este anuncio ya está archivado.");
  if (row.status === "CREATING") return fail("Este anuncio todavía se está creando.");
  const { token } = account.auth;
  try {
    if (row.status !== "FAILED") {
      const left = await rollbackToPaused(token, [row.metaCampaignId, row.metaAdSetId, row.metaAdId].filter((x): x is string => !!x));
      if (left.length) return fail("No se pudo pausar el anuncio en Meta antes de archivarlo. Inténtalo de nuevo.");
      if (row.metaCampaignId) await meta.setStatus(token, row.metaCampaignId, "ARCHIVED");
    }
    await db.adPromotion.update({ where: { id }, data: { status: "ARCHIVED", lastSyncedAt: now } });
    await audit("ads.archived", { userId: actorId, target: id, detail: { name: row.name } });
    return { ok: true };
  } catch (e) {
    return fail(await failureMessage(e, account.id, "archivar"));
  }
}

// ---------------------------------------------------------------------------
// Estado real (lo que dice Meta)
// ---------------------------------------------------------------------------

/** Lee de Meta el estado del anuncio y lo guarda (si lo pausaron o archivaron en Meta, aqui tambien). Nunca lanza. */
export async function syncPromotion(id: string, now = new Date()): Promise<Result<{ effectiveStatus: string | null }>> {
  try {
    const loaded = await loadPromotion(id);
    if (!loaded.ok) return loaded;
    const { row, account } = loaded;
    if (!row.metaAdId || (row.status !== "ACTIVE" && row.status !== "PAUSED")) return { ok: true, effectiveStatus: null };
    try {
      const ad = await meta.readStatus(account.auth.token, row.metaAdId);
      const next = statusFromMeta(ad.effectiveStatus);
      await db.adPromotion.update({
        where: { id },
        data: { effectiveStatus: ad.effectiveStatus, lastSyncedAt: now, ...(next && next !== row.status ? { status: next } : {}) },
      });
      return { ok: true, effectiveStatus: ad.effectiveStatus };
    } catch (e) {
      return fail(await failureMessage(e, account.id, "sincronizar"));
    }
  } catch (e) {
    console.error("[anuncios] fallo al sincronizar", describeInternalError(e));
    return fail("No se pudo leer el estado en Meta.");
  }
}

/** Anuncios activos se releen cada 30 min y los pausados cada 6 h. */
const SYNC_ACTIVE_MS = 30 * 60_000;
const SYNC_PAUSED_MS = 6 * 3_600_000;

/** Proceso en segundo plano: relee el estado de los anuncios y da por fallidas las creaciones interrumpidas. Nunca lanza. */
export async function syncDuePromotions(now = new Date(), limit = 5): Promise<{ synced: number; recovered: number }> {
  const out = { synced: 0, recovered: 0 };
  try {
    const stale = await db.adPromotion.updateMany({
      where: { status: "CREATING", createdAt: { lt: new Date(now.getTime() - STALE_CREATING_MS) } },
      data: { status: "FAILED", error: "La creación se interrumpió. Si quedó algo creado en Meta está en pausa: revísalo en el Administrador de anuncios." },
    });
    out.recovered = stale.count;

    const due = await db.adPromotion.findMany({
      where: {
        OR: [
          { status: "ACTIVE", OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now.getTime() - SYNC_ACTIVE_MS) } }] },
          { status: "PAUSED", OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now.getTime() - SYNC_PAUSED_MS) } }] },
        ],
        adAccount: { status: "ACTIVE" },
      },
      select: { id: true },
      orderBy: { lastSyncedAt: "asc" },
      take: limit,
    });
    for (const p of due) {
      const r = await syncPromotion(p.id, now);
      if (r.ok) out.synced++;
    }
  } catch (e) {
    console.error("[anuncios] fallo la vuelta", describeInternalError(e));
  }
  return out;
}
