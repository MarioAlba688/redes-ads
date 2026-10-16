import "server-only";
import { ADS_PLATFORMS, syncAdAccount } from "@/lib/ads/sync";
import { db } from "@/lib/db";
import { describeInternalError } from "@/lib/errors";
import { syncDuePromotions } from "@/lib/promotions/service";
import { runDuePublications } from "@/lib/publishing/run";
import { refreshDueMetrics } from "@/lib/stats/refresh";

// Proceso en segundo plano que vive dentro del servidor de la app (se arranca desde instrumentation.ts).
// Cada vuelta: publica lo que ya toca y, de vez en cuando, actualiza el rendimiento de los anuncios, las
// estadisticas de lo publicado y el estado de los anuncios creados desde la app (esto ultimo al final y con
// tiempo limitado: publicar a su hora es lo primero).
// Funciona en un servidor que se queda encendido (el VPS); no en plataformas "serverless".

const ADS_SYNC_EVERY_MS = 6 * 60 * 60_000;
const ADS_PER_TICK = 5; // para no saturar los limites de Meta

type WorkerState = { timer: ReturnType<typeof setInterval>; running: boolean };
const globalForWorker = globalThis as unknown as { __redesWorker?: WorkerState };

/** Actualiza el rendimiento de las cuentas publicitarias (Meta, Google Ads, TikTok) que llevan mas de 6 horas sin sincronizar. */
export async function syncStaleAdAccounts(now = new Date()): Promise<number> {
  const stale = await db.socialAccount.findMany({
    where: {
      platform: { in: ADS_PLATFORMS },
      kind: "AD_ACCOUNT",
      status: "ACTIVE",
      // Google guarda un token de renovacion ademas del de acceso; con cualquiera de los dos se puede sincronizar.
      OR: [{ accessTokenEnc: { not: null } }, { refreshTokenEnc: { not: null } }],
      AND: [{ OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now.getTime() - ADS_SYNC_EVERY_MS) } }] }],
    },
    select: { id: true },
    orderBy: { lastSyncedAt: "asc" },
    take: ADS_PER_TICK,
  });
  for (const a of stale) await syncAdAccount(a.id, { days: 30 });
  return stale.length;
}

async function tick(state: WorkerState) {
  if (state.running) return; // la vuelta anterior sigue en marcha
  state.running = true;
  try {
    await runDuePublications();
    await syncStaleAdAccounts();
    await refreshDueMetrics();
    await syncDuePromotions();
  } catch (e) {
    console.error("[worker] fallo una vuelta", describeInternalError(e));
  } finally {
    state.running = false;
  }
}

/** Arranca el proceso (una sola vez por servidor, aunque se llame varias). WORKER_ENABLED=false lo desactiva. */
export function startWorker(opts: { intervalSeconds?: number; enabled?: boolean } = {}): void {
  if (globalForWorker.__redesWorker) return;
  if (opts.enabled === false) return;

  const everyMs = Math.max(opts.intervalSeconds ?? 30, 1) * 1000;
  const state = { running: false } as WorkerState;
  state.timer = setInterval(() => void tick(state), everyMs);
  state.timer.unref?.(); // no impide que el servidor se apague
  globalForWorker.__redesWorker = state;
  setTimeout(() => void tick(state), Math.min(5000, everyMs)); // primera vuelta poco despues de arrancar
  console.log(`[worker] activo: revisa publicaciones cada ${Math.round(everyMs / 1000)} s`);
}
