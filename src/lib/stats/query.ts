import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { mediaPath } from "@/lib/media";
import { STATS_KINDS, type StatsFilters, type StatsKind } from "@/lib/stats/filters";
import { isMeasurable, MEASURABLE_WHERE } from "@/lib/stats/measurable";
import type { PostMetrics } from "@/lib/stats/metrics";

// Lectura de las publicaciones ya hechas con sus estadisticas, para la pantalla Estadisticas y para «Actualizar».

/** Tope de publicaciones por consulta: la pantalla resume y lista, no es un exportador. */
export const STATS_ROW_LIMIT = 300;

export type StatRow = {
  targetId: string;
  postId: string;
  text: string;
  brandId: string;
  brandName: string;
  accountName: string;
  kind: StatsKind;
  publishedAt: Date;
  externalUrl: string | null;
  /** Primera imagen; en un video, su portada (null si no tiene). */
  imageUrl: string | null;
  /** La publicacion es un video (un Reel). */
  isVideo: boolean;
  /** false = todavia no se leen sus estadisticas (Reel de Facebook); no es lo mismo que «aun sin leer». */
  measurable: boolean;
  metrics: PostMetrics | null;
  /** Ultima lectura buena. */
  fetchedAt: Date | null;
  /** Lo que no se pudo leer la ultima vez. */
  note: string | null;
};

/**
 * Publicaciones ya hechas del periodo y los filtros. Las historias duran 24 horas: no tienen estadisticas que leer
 * despues y no se listan. Los videos si: los Reels de Instagram se leen; los de Facebook se listan con un aviso. Con
 * `measurableOnly` se dejan solo los que se pueden leer (lo que necesita «Actualizar»).
 */
export function statsWhere(f: StatsFilters, now: Date, opts: { measurableOnly?: boolean } = {}): Prisma.PostTargetWhereInput {
  return {
    status: "PUBLISHED",
    externalId: { not: null },
    publishedAt: { gte: new Date(now.getTime() - f.days * 86_400_000) },
    account: { platform: "META", kind: f.kind ? f.kind : { in: [...STATS_KINDS] } },
    post: { format: "FEED", ...(f.brandId ? { brandId: f.brandId } : {}) },
    ...(opts.measurableOnly ? { AND: [MEASURABLE_WHERE] } : {}),
  };
}

export async function loadStatRows(
  f: StatsFilters,
  now = new Date(),
  take = STATS_ROW_LIMIT,
  opts: { measurableOnly?: boolean } = {},
): Promise<StatRow[]> {
  const targets = await db.postTarget.findMany({
    where: statsWhere(f, now, opts),
    orderBy: { publishedAt: "desc" },
    take,
    select: {
      id: true,
      postId: true,
      externalUrl: true,
      publishedAt: true,
      account: { select: { name: true, kind: true } },
      post: {
        select: {
          text: true,
          brand: { select: { id: true, name: true } },
          // Un video va solo (no se mezcla con imagenes): si lo hay, es el primero.
          media: { orderBy: { position: "asc" }, take: 1, select: { kind: true, storageKey: true, thumbKey: true } },
        },
      },
      metrics: true,
    },
  });

  return targets.map((t) => {
    const cover = t.post.media[0];
    const isVideo = cover?.kind === "VIDEO";
    return {
      targetId: t.id,
      postId: t.postId,
      text: t.post.text,
      brandId: t.post.brand.id,
      brandName: t.post.brand.name,
      accountName: t.account.name,
      kind: t.account.kind as StatsKind,
      publishedAt: t.publishedAt ?? new Date(0),
      externalUrl: t.externalUrl,
      // El archivo de un video no es una imagen: se muestra su portada, si la tiene.
      imageUrl: !cover ? null : isVideo ? (cover.thumbKey ? mediaPath(cover.thumbKey) : null) : mediaPath(cover.storageKey),
      isVideo,
      measurable: isMeasurable({ accountKind: t.account.kind, isVideo }),
      // Una fila creada solo para anotar un fallo (sin ninguna cifra) cuenta como "sin leer".
      metrics:
        t.metrics && [t.metrics.views, t.metrics.reach, t.metrics.likes, t.metrics.comments, t.metrics.shares, t.metrics.saves].some((v) => v !== null)
          ? { views: t.metrics.views, reach: t.metrics.reach, likes: t.metrics.likes, comments: t.metrics.comments, shares: t.metrics.shares, saves: t.metrics.saves }
          : null,
      fetchedAt: t.metrics?.fetchedAt ?? null,
      note: t.metrics?.note ?? null,
    };
  });
}
