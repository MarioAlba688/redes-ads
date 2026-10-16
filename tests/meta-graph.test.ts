import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaConfig } from "@/lib/meta/config";
import { MetaApiError } from "@/lib/meta/errors";
import { appSecretProof, graphGet, graphGetAll } from "@/lib/meta/graph";
import { APP_ID, APP_SECRET, setMetaEnv, stubFetch } from "./helpers/meta-env";

beforeEach(() => setMetaEnv());
afterEach(() => vi.unstubAllGlobals());

/** Espera que la promesa falle y devuelve el error (falla la prueba si no falla). */
async function rejection(p: Promise<unknown>): Promise<MetaApiError> {
  try {
    await p;
  } catch (e) {
    return e as MetaApiError;
  }
  throw new Error("Se esperaba un error y la llamada tuvo exito.");
}

describe("configuracion de Meta", () => {
  it("devuelve null si faltan el ID o el secreto de la app", async () => {
    // env() guarda su resultado; para probar otra combinacion se importa un modulo limpio.
    vi.resetModules();
    setMetaEnv({ META_APP_ID: undefined });
    const { metaConfig: fresh } = await import("@/lib/meta/config");
    expect(fresh()).toBeNull();
  });

  it("arma la URL de retorno desde APP_URL y usa los dominios reales de Meta", () => {
    const cfg = metaConfig();
    expect(cfg).toMatchObject({
      appId: APP_ID,
      version: "v26.0",
      graphBase: "https://graph.facebook.com",
      dialogBase: "https://www.facebook.com",
      redirectUri: "http://localhost:3000/api/meta/callback",
    });
  });

  it("solo acepta un servidor de pruebas en localhost", async () => {
    vi.resetModules();
    setMetaEnv({ META_API_BASE_URL: "https://evil.example.com" });
    const { env: fresh } = await import("@/lib/env");
    expect(() => fresh()).toThrow(/localhost/);

    vi.resetModules();
    setMetaEnv({ META_API_BASE_URL: "http://127.0.0.1:4010/" });
    const mod = await import("@/lib/meta/config");
    expect(mod.metaConfig()?.graphBase).toBe("http://127.0.0.1:4010");
  });

  it("valida el formato de la version de la API", async () => {
    vi.resetModules();
    setMetaEnv({ META_GRAPH_VERSION: "26" });
    const { env: fresh } = await import("@/lib/env");
    expect(() => fresh()).toThrow(/META_GRAPH_VERSION/);
  });

  it("env() sigue funcionando sin variables de Meta", async () => {
    vi.resetModules();
    setMetaEnv({ META_APP_ID: undefined, META_APP_SECRET: undefined });
    const { env: fresh } = await import("@/lib/env");
    expect(fresh().META_APP_ID).toBeUndefined();
    expect(fresh().META_GRAPH_VERSION).toBe("v26.0");
  });
});

describe("graphGet", () => {
  it("firma la llamada con access_token y appsecret_proof, y usa la version configurada", async () => {
    const calls = stubFetch(() => ({ body: { id: "1" } }));
    await graphGet("me", { token: "TOKEN-123", params: { fields: "id,name", omitido: undefined } });

    const { url } = calls[0];
    expect(url.origin + url.pathname).toBe("https://graph.facebook.com/v26.0/me");
    expect(url.searchParams.get("fields")).toBe("id,name");
    expect(url.searchParams.has("omitido")).toBe(false);
    expect(url.searchParams.get("access_token")).toBe("TOKEN-123");
    expect(url.searchParams.get("appsecret_proof")).toBe(
      createHmac("sha256", APP_SECRET).update("TOKEN-123").digest("hex"),
    );
  });

  it("appSecretProof es un HMAC-SHA256 en hexadecimal", () => {
    expect(appSecretProof("t", "s")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sin token no agrega parametros de autenticacion", async () => {
    const calls = stubFetch(() => ({ body: {} }));
    await graphGet("oauth/access_token", { params: { code: "abc" } });
    expect(calls[0].url.searchParams.has("access_token")).toBe(false);
    expect(calls[0].url.searchParams.has("appsecret_proof")).toBe(false);
  });

  it("convierte un error de Meta en MetaApiError con su codigo", async () => {
    stubFetch(() => ({
      status: 400,
      body: { error: { message: "Error validating access token", type: "OAuthException", code: 190, error_subcode: 463, fbtrace_id: "AbC" } },
    }));
    const err = await rejection(graphGet("me", { token: "x" }));
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err).toMatchObject({ code: 190, subcode: 463, type: "OAuthException", fbtraceId: "AbC", status: 400 });
    expect(err.isAuthError).toBe(true);
    expect(err.isRateLimit).toBe(false);
    expect(err.userMessage).toMatch(/Vuelve a conectar/);
  });

  it("reconoce limites de uso y falta de permisos", async () => {
    stubFetch(() => ({ status: 400, body: { error: { message: "limit", code: 80004 } } }));
    expect(await graphGet("x").catch((e) => e)).toMatchObject({ isRateLimit: true });

    stubFetch(() => ({ status: 403, body: { error: { message: "perm", code: 200 } } }));
    expect(await graphGet("x").catch((e) => e)).toMatchObject({ isPermissionError: true });
  });

  it("trata un error dentro de una respuesta 200 como error", async () => {
    stubFetch(() => ({ body: { error: { message: "raro", code: 1 } } }));
    await expect(graphGet("x")).rejects.toBeInstanceOf(MetaApiError);
  });

  it("si falla la red, el error no contiene el token ni la URL", async () => {
    stubFetch(() => new Error("fetch failed: https://graph.facebook.com/v26.0/me?access_token=SECRETO-XYZ"));
    const err = await rejection(graphGet("me", { token: "SECRETO-XYZ" }));
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.network).toBe(true);
    expect(JSON.stringify([err.message, err.userMessage, String(err.stack)])).not.toContain("SECRETO-XYZ");
  });

  it("falla con claridad si la respuesta no es JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    const err = await rejection(graphGet("x"));
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.status).toBe(502);
  });
});

describe("graphGetAll", () => {
  it("recorre las paginas con el cursor `after` y no sigue la URL paging.next", async () => {
    const calls = stubFetch((url, n) => {
      if (n === 1) {
        return {
          body: {
            data: [{ i: 1 }, { i: 2 }],
            paging: { cursors: { after: "C1" }, next: "https://sitio-malicioso.example/robar?token=1" },
          },
        };
      }
      return { body: { data: [{ i: 3 }], paging: { cursors: { after: "C2" } } } };
    });

    const items = await graphGetAll<{ i: number }>("me/accounts", { token: "T" });
    expect(items.map((x) => x.i)).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.url.hostname === "graph.facebook.com")).toBe(true);
    expect(calls[0].url.searchParams.has("after")).toBe(false);
    expect(calls[1].url.searchParams.get("after")).toBe("C1");
  });

  it("una lista vacia o sin `data` devuelve []", async () => {
    stubFetch(() => ({ body: {} }));
    expect(await graphGetAll("x")).toEqual([]);
  });

  it("corta si Meta nunca deja de paginar", async () => {
    stubFetch(() => ({ body: { data: [{}], paging: { cursors: { after: "X" }, next: "n" } } }));
    await expect(graphGetAll("x")).rejects.toThrow(/demasiadas paginas/);
  });
});
