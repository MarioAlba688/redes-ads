import "server-only";
import { MetaApiError } from "@/lib/meta/errors";
import { graphGet, type GraphParams } from "@/lib/meta/graph";
import { STATS_SCOPE } from "@/lib/meta/scopes";
import { clampCount, EMPTY_METRICS, type FailureKind, type PostMetrics } from "@/lib/stats/metrics";

// Lee de Meta las estadisticas de una publicacion ya hecha. Meta cambia sus metricas cada poco (en 2025 retiro las
// "impresiones" y puso "vistas" y "alcance"), asi que esto esta hecho para que una metrica que desaparezca, o un
// permiso que falte, solo quite esa parte: las demas cifras se guardan igual y se explica que faltó.

type Account = { externalId: string; token: string };

export type FetchedMetrics = {
  metrics: PostMetrics;
  /** Lo que no se pudo leer, en español (vacio si llego todo). */
  notes: string[];
  /** Algo fallo por un motivo pasajero (limite de uso, red): conviene reintentar pronto. */
  transient: boolean;
};

type FetchOptions = {
  /** Pedir tambien vistas, alcance y guardados (necesitan un permiso extra). */
  insights?: boolean;
};

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/** Meta responde "(#100) Unsupported get request. Object with ID ... does not exist, cannot be loaded due to missing permissions..." */
function isNotFound(e: MetaApiError): boolean {
  return e.code === 100 && (e.subcode === 33 || /does not exist|unsupported get request/i.test(e.message));
}

/** Una metrica que Meta ya no ofrece (o no admite para este tipo de publicacion). */
function isInvalidMetric(e: MetaApiError): boolean {
  return e.code === 100 && !isNotFound(e);
}

export type ClassifiedStatsError = { kind: FailureKind; message: string };

/** Convierte un fallo al leer estadisticas en un tipo (que decide cuando reintentar) y un mensaje en español. */
export function classifyStatsError(e: unknown, accountKind: string): ClassifiedStatsError {
  const scopes = STATS_SCOPE[accountKind as keyof typeof STATS_SCOPE];
  if (e instanceof MetaApiError) {
    if (e.isAuthError) {
      return { kind: "expired", message: "La conexión con Meta de esta cuenta venció o fue revocada. Reconecta Meta en Cuentas." };
    }
    if (e.isRateLimit) return { kind: "rate", message: "Meta pidió esperar por exceso de consultas. Se volverá a intentar." };
    if (e.network) return { kind: "network", message: "No se pudo contactar a Meta (red o tiempo de espera). Se volverá a intentar." };
    if (e.status >= 500 || e.code === 1 || e.code === 2) {
      return { kind: "network", message: "Meta tuvo un problema temporal. Se volverá a intentar." };
    }
    if (e.isPermissionError) {
      const need = scopes ? `${scopes.basic} y ${scopes.insights}` : "los permisos de estadísticas";
      return {
        kind: "permission",
        message: `Meta no dejó leer las estadísticas: la app necesita ${need} y tu usuario debe tener acceso a la cuenta. Detalle de Meta: ${e.message.slice(0, 160)}`,
      };
    }
    if (isNotFound(e)) {
      return { kind: "gone", message: "Meta no encuentra esta publicación (la borraron en la red social, o falta un permiso para verla)." };
    }
    return { kind: "other", message: `Meta rechazó la lectura de estadísticas: ${e.message.slice(0, 200)}` };
  }
  return { kind: "other", message: "Error interno al leer las estadísticas. Revisa los registros del servidor." };
}

// ---------------------------------------------------------------------------
// Lectura de insights
// ---------------------------------------------------------------------------

type InsightsResponse = {
  data?: { name?: string; values?: { value?: unknown }[]; total_value?: { value?: unknown } }[];
};

function readInsights(res: InsightsResponse): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const item of res.data ?? []) {
    if (!item.name) continue;
    out[item.name] = clampCount(item.values?.[0]?.value ?? item.total_value?.value);
  }
  return out;
}

type InsightsResult = {
  values: Record<string, number | null>;
  /** Metricas que Meta rechazo por no existir o no aplicar a esta publicacion. */
  invalid: string[];
  /** El primer error que no fue de "metrica invalida" (permisos, limite de uso, red...). */
  failure: MetaApiError | null;
};

/**
 * Pide varias metricas juntas; si Meta rechaza alguna por invalida, las pide de a una para quedarse con las que si
 * existen. Un error de otro tipo (permisos, limite de uso) corta: repetir no lo arreglaria. Un token vencido se relanza.
 */
async function readMetrics(path: string, token: string, metrics: string[], extra: GraphParams = {}): Promise<InsightsResult> {
  const result: InsightsResult = { values: {}, invalid: [], failure: null };
  const ask = async (list: string[]) => readInsights(await graphGet<InsightsResponse>(path, { token, params: { ...extra, metric: list.join(",") } }));

  try {
    result.values = await ask(metrics);
    return result;
  } catch (e) {
    if (!(e instanceof MetaApiError) || e.isAuthError) throw e;
    if (!isInvalidMetric(e) || metrics.length === 1) {
      if (isInvalidMetric(e)) result.invalid.push(...metrics);
      else result.failure = e;
      return result;
    }
  }

  for (const metric of metrics) {
    try {
      Object.assign(result.values, await ask([metric]));
    } catch (e) {
      if (!(e instanceof MetaApiError) || e.isAuthError) throw e;
      if (isInvalidMetric(e)) result.invalid.push(metric);
      else {
        result.failure = e;
        break;
      }
    }
  }
  return result;
}

const METRIC_NAMES: Record<string, string> = {
  post_media_view: "vistas",
  post_total_media_view_unique: "alcance",
  views: "vistas",
  reach: "alcance",
  saved: "guardados",
  shares: "compartidos",
};

/** Explica en español que parte de los insights no llego. Devuelve si el problema fue pasajero. */
function describeInsightsProblems(result: InsightsResult, accountKind: string, notes: string[]): boolean {
  if (result.invalid.length) {
    const names = result.invalid.map((m) => METRIC_NAMES[m] ?? m).join(", ");
    notes.push(`Meta no entregó: ${names} (ya no ofrece esa métrica, o no aplica a este tipo de publicación).`);
  }
  if (!result.failure) return false;
  const c = classifyStatsError(result.failure, accountKind);
  const scope = STATS_SCOPE[accountKind as keyof typeof STATS_SCOPE]?.insights;
  if (c.kind === "permission") {
    notes.push(`No se leyeron las vistas ni el alcance: falta el permiso ${scope ?? "de estadísticas"}. Detalle de Meta: ${result.failure.message.slice(0, 160)}`);
    return false;
  }
  notes.push(`No se leyeron las vistas ni el alcance. ${c.message}`);
  return c.kind === "rate" || c.kind === "network";
}

// ---------------------------------------------------------------------------
// Facebook
// ---------------------------------------------------------------------------

type FacebookPost = {
  reactions?: { summary?: { total_count?: unknown } };
  comments?: { summary?: { total_count?: unknown } };
  shares?: { count?: unknown };
};

/**
 * Estadisticas de una publicacion de una pagina de Facebook (con el token de la pagina). Reacciones, comentarios y
 * compartidos salen de la publicacion misma (permiso pages_read_engagement); vistas y alcance, de sus insights
 * (permiso read_insights). Si falla lo primero se lanza el error: sin eso no hay nada que guardar.
 */
export async function fetchFacebookPostMetrics(page: Account, postId: string, opts: FetchOptions = {}): Promise<FetchedMetrics> {
  const post = await graphGet<FacebookPost>(postId, {
    token: page.token,
    params: { fields: "reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares" },
  });
  const metrics: PostMetrics = {
    ...EMPTY_METRICS,
    likes: clampCount(post.reactions?.summary?.total_count) ?? 0,
    comments: clampCount(post.comments?.summary?.total_count) ?? 0,
    // Facebook omite `shares` cuando nadie la compartio.
    shares: clampCount(post.shares?.count) ?? 0,
  };

  const notes: string[] = [];
  let transient = false;
  if (opts.insights !== false) {
    const res = await readMetrics(`${postId}/insights`, page.token, ["post_media_view", "post_total_media_view_unique"]);
    metrics.views = res.values.post_media_view ?? null;
    metrics.reach = res.values.post_total_media_view_unique ?? null;
    transient = describeInsightsProblems(res, "FACEBOOK_PAGE", notes);
  }
  return { metrics, notes, transient };
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

type InstagramMedia = { like_count?: unknown; comments_count?: unknown };

/**
 * Estadisticas de una publicacion de Instagram. "Me gusta" y comentarios salen de la publicacion (instagram_basic);
 * alcance, vistas, guardados y compartidos, de sus insights (instagram_manage_insights). Instagram oculta
 * `like_count` si la cuenta escondio los "me gusta": en ese caso queda sin dato.
 */
export async function fetchInstagramMediaMetrics(ig: Account, mediaId: string, opts: FetchOptions = {}): Promise<FetchedMetrics> {
  const media = await graphGet<InstagramMedia>(mediaId, { token: ig.token, params: { fields: "like_count,comments_count" } });
  const metrics: PostMetrics = {
    ...EMPTY_METRICS,
    likes: clampCount(media.like_count),
    comments: clampCount(media.comments_count),
  };

  const notes: string[] = [];
  let transient = false;
  if (opts.insights !== false) {
    const res = await readMetrics(`${mediaId}/insights`, ig.token, ["reach", "views", "saved", "shares"]);
    metrics.reach = res.values.reach ?? null;
    metrics.views = res.values.views ?? null;
    metrics.saves = res.values.saved ?? null;
    metrics.shares = res.values.shares ?? null;
    transient = describeInsightsProblems(res, "INSTAGRAM_PROFILE", notes);
  }
  return { metrics, notes, transient };
}
