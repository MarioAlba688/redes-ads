import { vi } from "vitest";

export const APP_ID = "123456789012345";
export const APP_SECRET = "secreto-de-prueba-de-la-app-meta";

/** Variables minimas para que env() y metaConfig() funcionen en una prueba. */
export function setMetaEnv(extra: Record<string, string | undefined> = {}) {
  process.env.DATABASE_URL = "mysql://u:p@localhost:3306/prueba";
  process.env.APP_URL = "http://localhost:3000";
  process.env.META_APP_ID = APP_ID;
  process.env.META_APP_SECRET = APP_SECRET;
  delete process.env.META_GRAPH_VERSION;
  delete process.env.META_LOGIN_CONFIG_ID;
  delete process.env.META_SCOPES;
  delete process.env.META_API_BASE_URL;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

export type FakeCall = { url: URL };

/**
 * Reemplaza fetch por un servidor falso. `handler` recibe la URL y devuelve el cuerpo JSON
 * (y opcionalmente el status). Devuelve la lista de llamadas hechas.
 */
export function stubFetch(
  handler: (url: URL, n: number) => { body: unknown; status?: number } | Error,
): FakeCall[] {
  const calls: FakeCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      calls.push({ url });
      const result = handler(url, calls.length);
      if (result instanceof Error) throw result;
      return new Response(JSON.stringify(result.body), {
        status: result.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}
