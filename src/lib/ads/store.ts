import "server-only";
import type { InsightRow } from "@/lib/ads/types";
import { db } from "@/lib/db";
import { toDbDate } from "@/lib/meta/dates";

const CHUNK = 500;

/** Reemplaza el rendimiento guardado en [since, until] por el que acaba de devolver la plataforma. */
export async function replaceInsights(accountId: string, since: string, until: string, rows: InsightRow[]) {
  // Una fila por (dia, campaña): si la plataforma repitiera alguna, la ultima gana.
  const unique = new Map<string, InsightRow>();
  for (const r of rows) unique.set(`${r.date}|${r.campaignId}`, r);

  const data = [...unique.values()].map((r) => ({
    accountId,
    date: toDbDate(r.date),
    campaignId: r.campaignId.slice(0, 64),
    campaignName: r.campaignName,
    spend: r.spend,
    impressions: BigInt(r.impressions),
    clicks: BigInt(r.clicks),
    reach: BigInt(r.reach),
    ...(r.actions ? { actions: r.actions } : {}),
  }));

  // Borrar y reinsertar en una sola transaccion (si algo falla, no queda la ventana a medias).
  // El limite de tiempo se amplia: con la base lejos, cada consulta tarda ~0,2 s y varios lotes
  // de 500 filas superarian los 5 s por defecto.
  await db.$transaction(
    async (tx) => {
      await tx.adInsightDaily.deleteMany({
        where: { accountId, date: { gte: toDbDate(since), lte: toDbDate(until) } },
      });
      for (let i = 0; i < data.length; i += CHUNK) {
        await tx.adInsightDaily.createMany({ data: data.slice(i, i + CHUNK) });
      }
    },
    { timeout: 60_000, maxWait: 15_000 },
  );
  return data.length;
}
