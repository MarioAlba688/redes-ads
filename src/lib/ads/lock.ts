// Candado en memoria para que una misma cuenta no se sincronice dos veces a la vez dentro del mismo proceso (por ejemplo,
// el proceso en segundo plano y alguien pulsando «Sincronizar»): ambas reemplazarian la misma ventana de datos y podrian
// chocar entre si en la base. Vive en `globalThis` porque el worker y las acciones de las paginas se cargan en grafos de
// modulos distintos dentro del mismo proceso.

const g = globalThis as unknown as { __redesSyncing?: Set<string> };
const running = (g.__redesSyncing ??= new Set<string>());

export async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  if (running.has(accountId)) return { ran: false };
  running.add(accountId);
  try {
    return { ran: true, value: await fn() };
  } finally {
    running.delete(accountId);
  }
}
