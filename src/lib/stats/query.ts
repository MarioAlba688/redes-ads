import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { mediaPath } from "@/lib/media";
import { STATS_KINDS, type StatsFilters, type StatsKind } from "@/lib/stats/filters";
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
  imageUrl: string | null;
  metrics: PostMetrics | null;
  /** Ultima lectura buena. */
  fetchedAt: Date | null;
  /** Lo que no se pudo leer la ultima vez. */
  note: string | null;
};

export function statsWhere(f: StatsFilters, now: Date): Prisma.PostTargetWhereInput {
  return {
    status: "PUBLISHED",
    externalId: { not: null },
    publishedAt: { gte: new Date(now.getTime() - f.days * 86_400_000) },
    account: { platform: "META", kind: f.kind ? f.kind : { in: [...STATS_KINDS] } },
    ...(f.brandId ? { post: { brandId: f.brandId } } : {}),
  };
}

export async function loadStatRows(f: StatsFilters, now = new Date(), take = STATS_ROW_LIMIT): Promise<StatRow[]> {
  const targets = await db.postTarget.findMany({
    where: statsWhere(f, now),
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
          media: { orderBy: { position: "asc" }, take: 1, select: { storageKey: true } },
        },
      },
      metrics: true,
    },
  });

  return targets.map((t) => ({
    targetId: t.id,
    postId: t.postId,
    text: t.post.text,
    brandId: t.post.brand.id,
    brandName: t.post.brand.name,
    accountName: t.account.name,
    kind: t.account.kind as StatsKind,
    publishedAt: t.publishedAt ?? new Date(0),
    externalUrl: t.externalUrl,
    imageUrl: t.post.media[0] ? mediaPath(t.post.media[0].storageKey) : null,
    // Una fila creada solo para anotar un fallo (sin ninguna cifra) cuenta como "sin leer".
    metrics:
      t.metrics && [t.metrics.views, t.metrics.reach, t.metrics.likes, t.metrics.comments, t.metrics.shares, t.metrics.saves].some((v) => v !== null)
        ? { views: t.metrics.views, reach: t.metrics.reach, likes: t.metrics.likes, comments: t.metrics.comments, shares: t.metrics.shares, saves: t.metrics.saves }
        : null,
    fetchedAt: t.metrics?.fetchedAt ?? null,
    note: t.metrics?.note ?? null,
  }));
}
