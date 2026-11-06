import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMetaEnv } from "./helpers/meta-env";

// El proceso que publica (lib/publishing/run.ts) con un video, de punta a punta pero con la base de datos simulada en
// memoria y Meta simulado con fetch: comprueba las fases (esperar sin gastar intentos, publicar una sola vez, fallar).

type Target = {
  id: string;
  postId: string;
  status: "PENDING" | "PUBLISHING" | "PUBLISHED" | "FAILED";
  attempts: number;
  nextAttemptAt: Date | null;
  lockedAt: Date | null;
  remoteId: string | null;
  remoteStartedAt: Date | null;
  externalId: string | null;
  externalUrl: string | null;
  publishedAt: Date | null;
  error: string | null;
};

const h = vi.hoisted(() => ({ state: {} as { target: Target; post: { status: string; format: string; text: string; linkUrl: string | null; publishedAt: Date | null }; kind: string; thumbKey: string | null } }));

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ decryptSecret: () => "PAGE-TOKEN" }));
vi.mock("@/lib/media", async (orig) => ({ ...(await orig<typeof import("@/lib/media")>()), imageExists: vi.fn(async () => true), readImage: vi.fn(async () => Buffer.alloc(1000, 5)) }));
vi.mock("@/lib/db", () => {
  const s = h.state;
  const apply = (data: Record<string, unknown>) => Object.assign(s.target, data);
  return {
    db: {
      postTarget: {
        findMany: async ({ where }: { where: { status?: string; postId?: string } }) => {
          if (where.postId) return [{ status: s.target.status, remoteId: s.target.remoteId }];
          if (where.status === "PENDING") return s.target.status === "PENDING" && (!s.target.nextAttemptAt || s.target.nextAttemptAt <= new Date(NOW_MS.v)) ? [{ id: s.target.id, postId: s.target.postId }] : [];
          return []; // destinos colgados: ninguno
        },
        updateMany: async ({ where, data }: { where: { status?: string }; data: Record<string, unknown> }) => {
          if (where.status && s.target.status !== where.status) return { count: 0 };
          apply(data);
          return { count: 1 };
        },
        findUnique: async () => ({
          ...s.target,
          account: { id: "a1", name: "Reservi", kind: s.kind, externalId: "ACC1", status: "ACTIVE", accessTokenEnc: "enc", scopes: null },
          post: {
            id: s.target.postId,
            text: s.post.text,
            linkUrl: s.post.linkUrl,
            format: s.post.format,
            status: s.post.status,
            media: [{ id: "m1", kind: "VIDEO", mimeType: "video/mp4", size: 1000, storageKey: `${"a".repeat(48)}.mp4`, thumbKey: s.thumbKey, position: 0 }],
          },
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => apply(data),
      },
      post: {
        updateMany: async ({ where, data }: { where: { status: string | { in: string[] } }; data: { status?: string; publishedAt?: Date | null } }) => {
          const ok = typeof where.status === "string" ? s.post.status === where.status : where.status.in.includes(s.post.status);
          if (!ok) return { count: 0 };
          Object.assign(s.post, data);
          return { count: 1 };
        },
      },
      socialAccount: { updateMany: async () => ({ count: 1 }) },
    },
  };
});

const NOW_MS = { v: Date.parse("2026-11-06T12:00:00Z") };
let run: typeof import("@/lib/publishing/run");

beforeEach(async () => {
  setMetaEnv({ APP_URL: "https://app.example.com" });
  NOW_MS.v = Date.parse("2026-11-06T12:00:00Z");
  h.state.kind = "INSTAGRAM_PROFILE";
  h.state.thumbKey = null;
  h.state.post = { status: "SCHEDULED", format: "FEED", text: "Nuestro video", linkUrl: null, publishedAt: null };
  h.state.target = { id: "t1", postId: "p1", status: "PENDING", attempts: 0, nextAttemptAt: null, lockedAt: null, remoteId: null, remoteStartedAt: null, externalId: null, externalUrl: null, publishedAt: null, error: null };
  vi.resetModules();
  run = await import("@/lib/publishing/run");
});
afterEach(() => vi.unstubAllGlobals());

type Handler = (url: URL, form: Record<string, string>, n: number) => unknown;
function meta(handler: Handler) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const b = init?.body;
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const out = handler(url, b instanceof URLSearchParams ? Object.fromEntries(b) : {}, calls.length);
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}
const tick = (afterSeconds: number) => {
  NOW_MS.v += afterSeconds * 1000;
  return run.runDuePublications(new Date(NOW_MS.v));
};

describe("publicar un Reel de Instagram por fases", () => {
  it("espera sin gastar intentos, publica una sola vez y cierra la publicacion", async () => {
    let status = "IN_PROGRESS";
    const calls = meta((url) => {
      if (url.pathname.endsWith("/media_publish")) return { id: "M9" };
      if (url.pathname === "/v26.0/M9") return { permalink: "https://www.instagram.com/reel/abc/" };
      if (url.pathname.endsWith("/media")) return { id: "C1" };
      return { status_code: status };
    });

    // Vuelta 1: crea el contenedor y queda esperando.
    expect(await tick(0)).toMatchObject({ waiting: 1, published: 0, failed: 0 });
    expect(h.state.target).toMatchObject({ status: "PENDING", remoteId: "C1", attempts: 0, error: null, lockedAt: null });
    expect(h.state.target.remoteStartedAt).toEqual(new Date(NOW_MS.v));
    expect(h.state.target.nextAttemptAt!.getTime()).toBe(NOW_MS.v + 30_000);
    expect(h.state.post.status).toBe("PUBLISHING"); // en camino, no «programada»

    // Antes de tiempo no se vuelve a tocar.
    expect(await tick(10)).toMatchObject({ waiting: 0, published: 0 });
    expect(calls).toHaveLength(1);

    // Vuelta 2: sigue procesando.
    expect(await tick(30)).toMatchObject({ waiting: 1 });
    expect(h.state.target).toMatchObject({ status: "PENDING", remoteId: "C1", attempts: 0 });

    // Vuelta 3: listo -> se publica, una sola vez.
    status = "FINISHED";
    expect(await tick(40)).toMatchObject({ published: 1, waiting: 0 });
    expect(h.state.target).toMatchObject({ status: "PUBLISHED", externalId: "M9", externalUrl: "https://www.instagram.com/reel/abc/", attempts: 1, error: null, nextAttemptAt: null });
    expect(h.state.post.status).toBe("PUBLISHED");
    expect(calls.filter((c) => c.endsWith("/media_publish"))).toHaveLength(1);

    // Ya publicado: otra vuelta no hace nada.
    const before = calls.length;
    await tick(60);
    expect(calls).toHaveLength(before);
  });

  it("si Instagram rechaza el video al procesarlo, falla con su motivo y no se reintenta solo", async () => {
    meta((url) => (url.pathname.endsWith("/media") ? { id: "C1" } : { status_code: "ERROR", status: "formato no soportado" }));
    await tick(0);
    expect(await tick(40)).toMatchObject({ failed: 1 });
    expect(h.state.target).toMatchObject({ status: "FAILED", attempts: 1, nextAttemptAt: null, error: expect.stringMatching(/Instagram rechazó el video: formato no soportado/) });
    expect(h.state.post.status).toBe("FAILED");
  });

  it("publicar sin respuesta clara deja el destino fallido, sin reintento automatico (no se duplica)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/media_publish")) throw new Error("red caida");
        return new Response(JSON.stringify(path.endsWith("/media") ? { id: "C1" } : { status_code: "FINISHED" }), { status: 200 });
      }),
    );
    await tick(0);
    expect(await tick(40)).toMatchObject({ failed: 1, retrying: 0 });
    expect(h.state.target).toMatchObject({ status: "FAILED", nextAttemptAt: null, error: expect.stringMatching(/No se pudo confirmar si Instagram publicó el video/) });
  });

  it("un error al crear el contenedor (permisos de Instagram) falla sin dejar id guardado", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "(#200) Requires instagram_content_publish permission", code: 200 } }), { status: 403 })));
    expect(await tick(0)).toMatchObject({ failed: 1 });
    expect(h.state.target).toMatchObject({ status: "FAILED", remoteId: null, error: expect.stringMatching(/falta de permisos/) });
  });

  it("la portada del video viaja como cover_url cuando existe", async () => {
    h.state.thumbKey = `${"b".repeat(48)}.jpg`;
    const forms: Record<string, string>[] = [];
    meta((url, form) => {
      forms.push(form);
      return url.pathname.endsWith("/media") ? { id: "C1" } : { status_code: "FINISHED" };
    });
    await tick(0);
    expect(forms[0]).toMatchObject({ media_type: "REELS", cover_url: `https://app.example.com/media/${"b".repeat(48)}.jpg`, video_url: `https://app.example.com/media/${"a".repeat(48)}.mp4` });
  });
});

describe("publicar un Reel de Facebook por fases", () => {
  it("sube, finaliza y espera; despues confirma que ya salio", async () => {
    h.state.kind = "FACEBOOK_PAGE";
    let published = false;
    const calls = meta((url, form) => {
      if (url.pathname.endsWith("/video_reels")) return form.upload_phase === "start" ? { video_id: "V1", upload_url: "https://rupload.facebook.com/video-upload/v26.0/V1" } : { success: true };
      if (url.host === "rupload.facebook.com") return { success: true };
      return { status: { video_status: published ? "ready" : "processing", publishing_phase: published ? { status: "complete", publish_status: "published" } : { status: "in_progress" } } };
    });

    expect(await tick(0)).toMatchObject({ waiting: 1 });
    expect(h.state.target).toMatchObject({ status: "PENDING", remoteId: "V1", attempts: 0 });
    expect(calls).toEqual(["POST /v26.0/ACC1/video_reels", "POST /video-upload/v26.0/V1", "POST /v26.0/ACC1/video_reels"]);

    expect(await tick(30)).toMatchObject({ waiting: 1 });
    // Procesando: solo consulta; no vuelve a subir ni a finalizar.
    expect(calls.slice(3)).toEqual(["GET /v26.0/V1"]);

    published = true;
    expect(await tick(40)).toMatchObject({ published: 1 });
    expect(h.state.target).toMatchObject({ status: "PUBLISHED", externalId: "V1", externalUrl: "https://www.facebook.com/reel/V1" });
    expect(h.state.post.status).toBe("PUBLISHED");
    expect(calls.filter((c) => c.endsWith("/video_reels"))).toHaveLength(2); // start + finish, una sola vez cada uno
  });
});
