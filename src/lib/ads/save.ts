import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { describeInternalError } from "@/lib/errors";

export type SavePlatform = Prisma.SocialAccountUncheckedCreateInput["platform"];
export type SaveKind = Prisma.SocialAccountUncheckedCreateInput["kind"];
export type AccountData = Omit<Prisma.SocialAccountUncheckedCreateInput, "platform" | "kind" | "externalId">;
export type SaveItem = { kind: SaveKind; externalId: string; data: AccountData };

export type SkippedAccount = { kind: SaveKind; externalId: string; reason: Record<string, string | number> };

/** Cuantas cuentas existentes se actualizan a la vez. Con la base lejos (cada consulta tarda ~0,2 s) ir de una en una es lento. */
const SAVE_CONCURRENCY = 8;

/** Limites de las columnas (ver schema.prisma): las plataformas pueden devolver textos mas largos. */
export const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/**
 * Guarda (o actualiza) las cuentas que la persona conecto. Volver a conectar reactiva las existentes en lugar de
 * duplicarlas. Cada cuenta se guarda por separado, sin una transaccion que las envuelva a todas: con muchas cuentas y la
 * base en otro servidor, una transaccion unica superaria el tiempo maximo de Prisma (5 s) y la conexion entera fallaria.
 * Asi, ademas, una cuenta problematica queda en `skipped` sin impedir que se guarden las demas.
 */
export async function saveAccounts(platform: SavePlatform, list: SaveItem[]): Promise<{ saved: SaveKind[]; skipped: SkippedAccount[] }> {
  const saved: SaveKind[] = [];
  const skipped: SkippedAccount[] = [];
  const skip = (it: SaveItem, e: unknown) => skipped.push({ kind: it.kind, externalId: it.externalId, reason: describeInternalError(e) });

  // Pocas consultas en lugar de un `upsert` por cuenta (cada upsert de Prisma son varias idas y
  // vueltas): 1) ver cuales ya existen, 2) crear de golpe las nuevas, 3) actualizar las existentes.
  const existing = await db.socialAccount.findMany({
    where: { platform, externalId: { in: list.map((i) => i.externalId) } },
    select: { kind: true, externalId: true },
  });
  const exists = new Set(existing.map((e) => `${e.kind}:${e.externalId}`));
  const toCreate = list.filter((i) => !exists.has(`${i.kind}:${i.externalId}`));
  const toUpdate = list.filter((i) => exists.has(`${i.kind}:${i.externalId}`));

  if (toCreate.length > 0) {
    try {
      await db.socialAccount.createMany({
        data: toCreate.map(({ kind, externalId, data }) => ({ platform, kind, externalId, ...data })),
        skipDuplicates: true,
      });
      saved.push(...toCreate.map((i) => i.kind));
    } catch {
      // Una fila problematica hace fallar el lote entero: se reintenta una por una para aislarla.
      for (const it of toCreate) {
        try {
          await db.socialAccount.create({ data: { platform, kind: it.kind, externalId: it.externalId, ...it.data } });
          saved.push(it.kind);
        } catch (e) {
          skip(it, e);
        }
      }
    }
  }

  for (let i = 0; i < toUpdate.length; i += SAVE_CONCURRENCY) {
    await Promise.all(
      toUpdate.slice(i, i + SAVE_CONCURRENCY).map(async (it) => {
        try {
          await db.socialAccount.updateMany({ where: { platform, kind: it.kind, externalId: it.externalId }, data: it.data });
          saved.push(it.kind);
        } catch (e) {
          skip(it, e);
        }
      }),
    );
  }

  return { saved, skipped };
}
