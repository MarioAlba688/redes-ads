// Next.js ejecuta register() una vez al arrancar el servidor. Aqui se enciende el proceso en segundo plano
// que publica lo programado. WORKER_ENABLED=false lo desactiva (por ejemplo en una segunda copia de la app
// o mientras se hace mantenimiento); WORKER_INTERVAL_SECONDS cambia cada cuanto revisa (por defecto 30).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWorker } = await import("@/lib/worker");
  startWorker({
    enabled: process.env.WORKER_ENABLED !== "false",
    intervalSeconds: Number(process.env.WORKER_INTERVAL_SECONDS) || 30,
  });
}
