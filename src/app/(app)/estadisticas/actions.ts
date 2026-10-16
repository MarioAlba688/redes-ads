"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import type { FormState } from "@/lib/form-state";
import { parseStatsFilters } from "@/lib/stats/filters";
import { loadStatRows } from "@/lib/stats/query";
import { refreshTargetsNow } from "@/lib/stats/refresh";

/** Cuantas publicaciones se vuelven a leer de una vez (las mas nuevas): cada una son varias llamadas a Meta. */
const MANUAL_LIMIT = 12;

const text = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : null);

/** «Actualizar»: vuelve a leer en Meta las estadisticas de las publicaciones que se estan viendo (las mas recientes). */
export async function refreshStatsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("stats.refresh");
  if (!auth.ok) return { error: auth.error };

  const brands = await db.brand.findMany({ select: { id: true } });
  const filters = parseStatsFilters(
    { dias: text(formData.get("dias")), marca: text(formData.get("marca")), red: text(formData.get("red")) },
    brands.map((b) => b.id),
  );
  const rows = await loadStatRows(filters, new Date(), MANUAL_LIMIT);
  if (rows.length === 0) return { error: "No hay publicaciones para actualizar con estos filtros." };

  const result = await refreshTargetsNow(rows.map((r) => r.targetId));
  await audit("stats.refreshed", {
    userId: auth.user.id,
    detail: { refreshed: result.refreshed, failed: result.failed, skipped: result.skipped },
  });
  revalidatePath("/estadisticas");

  if (result.failed > 0 || (result.refreshed === 0 && result.firstProblem)) {
    const done = result.refreshed > 0 ? `Se actualizaron ${result.refreshed}. ` : "";
    const failed = result.failed > 0 ? `No se pudo leer ${result.failed}. ` : "";
    return { error: `${done}${failed}${result.firstProblem ?? ""}`.trim() };
  }
  if (result.refreshed === 0) return { success: "Todo estaba al día: se leyó hace menos de 2 minutos." };
  const upToDate = result.skipped > 0 ? ` ${result.skipped} ya estaban al día.` : "";
  const newest = rows.length === MANUAL_LIMIT ? ` (las ${MANUAL_LIMIT} más recientes)` : "";
  return { success: `Se actualizaron ${result.refreshed} publicaciones${newest}.${upToDate}` };
}
