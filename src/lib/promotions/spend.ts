import "server-only";
import { db } from "@/lib/db";
import { firstOfMonth } from "@/lib/promotions/monthly";
import { todayInTimezone, toDbDate } from "@/lib/meta/dates";

/**
 * Gasto de cada cuenta publicitaria en el mes calendario en curso (en la zona horaria de cada cuenta), segun el
 * rendimiento ya descargado de Meta. Solo para MOSTRAR; la decision de activar o frenar usa src/lib/promotions/service.ts,
 * que antes actualiza el rendimiento si esta viejo.
 */
export async function monthSpendByAccount(accounts: readonly { id: string; timezone: string | null }[], now = new Date()): Promise<Map<string, number>> {
  const entries = await Promise.all(
    accounts.map(async (a) => {
      const today = todayInTimezone(a.timezone, now);
      const agg = await db.adInsightDaily.aggregate({
        where: { accountId: a.id, date: { gte: toDbDate(firstOfMonth(today)), lte: toDbDate(today) } },
        _sum: { spend: true },
      });
      return [a.id, Number(agg._sum.spend ?? 0)] as const;
    }),
  );
  return new Map(entries);
}
