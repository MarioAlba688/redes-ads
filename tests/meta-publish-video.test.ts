import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaApiError } from "@/lib/meta/errors";
import { classifyPublishError, PublishError, publicMediaUrl, type PublishVideo } from "@/lib/meta/publish";
import { advanceVideoPublication, VIDEO_MAX_PROCESSING_MS, VIDEO_POLL_SECONDS, type AdvanceInput } from "@/lib/publishing/video";
import { derivePostStatus } from "@/lib/publishing/status";
import { setMetaEnv } from "./helpers/meta-env";

beforeEach(() => setMetaEnv());
afterEach(() => vi.unstubAllGlobals());

const account = { externalId: "ACC1", token: "PAGE-TOKEN" };
const NOW = new Date("2026-11-06T12:00:00Z");

const video = (over: Partial<PublishVideo> = {}): PublishVideo => ({
  size: 1000,
  mimeType: "video/mp4",
  publicUrl: "https://app.example.com/media/v.mp4",
  coverUrl: "https://app.example.com/media/c.jpg",
  read: async () => new Uint8Array(1000).fill(9),
  ...over,
});

type Call = { url: URL; method: string; headers: Record<string, string>; form: Record<string, string>; bodyLength: number | null };

/** fetch falso: guarda cada llamada y responde segun `handler`. */
function stub(handler: (c: Call, n: number) => { body: unknown; status?: number } | Error) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const b = init?.body;
      const call: Call = {
        url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
        form: b instanceof URLSearchParams ? Object.fromEntries(b) : {},
        bodyLength: b instanceof Uint8Array ? b.length : null,
      };
      calls.push(call);
      const r = handler(call, calls.length);
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const base = (over: Partial<AdvanceInput> = {}): AdvanceInput => ({
  instagram: true,
  story: false,
  account,
  text: "Mira nuestro nuevo video",
  linkUrl: "https://reservi.example",
  video: video(),
  remoteId: null,
  remoteStartedAt: null,
  now: NOW,
  ...over,
});

describe("Instagram: Reel y historia con video", () => {
  it("fase 1 de un Reel: crea el contenedor REELS con la URL, el pie, share_to_feed y la portada, y queda esperando", async () => {
    const calls = stub(() => ({ body: { id: "C1" } }));
    const step = await advanceVideoPublication(base());
    expect(step).toEqual({ kind: "waiting", remoteId: "C1", delaySeconds: VIDEO_POLL_SECONDS });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/v26.0/ACC1/media");
    expect(calls[0].url.search).toBe("");
    expect(calls[0].form).toMatchObject({
      media_type: "REELS",
      video_url: "https://app.example.com/media/v.mp4",
      caption: "Mira nuestro nuevo video",
      share_to_feed: "true",
      cover_url: "https://app.example.com/media/c.jpg",
      access_token: "PAGE-TOKEN",
    });
  });

  it("sin portada no manda cover_url; una historia usa STORIES, sin pie ni portada", async () => {
    const calls = stub(() => ({ body: { id: "C2" } }));
    await advanceVideoPublication(base({ video: video({ coverUrl: null }) }));
    expect(calls[0].form).not.toHaveProperty("cover_url");
    await advanceVideoPublication(base({ story: true }));
    expect(calls[1].form).toMatchObject({ media_type: "STORIES", video_url: "https://app.example.com/media/v.mp4" });
    expect(calls[1].form).not.toHaveProperty("caption");
    expect(calls[1].form).not.toHaveProperty("cover_url");
    expect(calls[1].form).not.toHaveProperty("share_to_feed");
  });

  it("fase 2: mientras Instagram procesa solo consulta el estado y sigue esperando (sin publicar)", async () => {
    const calls = stub(() => ({ body: { status_code: "IN_PROGRESS" } }));
    const step = await advanceVideoPublication(base({ remoteId: "C1", remoteStartedAt: new Date(NOW.getTime() - 60_000) }));
    expect(step).toEqual({ kind: "waiting", remoteId: "C1", delaySeconds: VIDEO_POLL_SECONDS });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname).toBe("/v26.0/C1");
    expect(calls[0].url.searchParams.get("fields")).toBe("status_code,status");
  });

  it("fase 3: con el contenedor FINISHED lo publica (una sola vez) y devuelve el enlace", async () => {
    const calls = stub((c) => {
      if (c.url.pathname.endsWith("/media_publish")) return { body: { id: "M9" } };
      if (c.url.pathname === "/v26.0/M9") return { body: { permalink: "https://www.instagram.com/reel/abc/" } };
      return { body: { status_code: "FINISHED" } };
    });
    const step = await advanceVideoPublication(base({ remoteId: "C1", remoteStartedAt: NOW }));
    expect(step).toEqual({ kind: "published", result: { externalId: "M9", url: "https://www.instagram.com/reel/abc/" } });
    expect(calls.filter((c) => c.url.pathname.endsWith("/media_publish"))).toHaveLength(1);
    expect(calls.find((c) => c.url.pathname.endsWith("/media_publish"))?.form).toMatchObject({ creation_id: "C1" });
  });

  it("ERROR, EXPIRED y PUBLISHED no se reintentan solos: explican que hacer", async () => {
    for (const [code, re] of [
      ["ERROR", /Instagram rechazó el video: formato/],
      ["EXPIRED", /24 horas/],
      ["PUBLISHED", /ya se publicó/],
    ] as const) {
      stub(() => ({ body: { status_code: code, status: "formato" } }));
      const step = await advanceVideoPublication(base({ remoteId: "C1", remoteStartedAt: NOW }));
      expect(step).toMatchObject({ kind: "failed", retryable: false, message: expect.stringMatching(re) });
    }
  });

  it("un fallo pasajero al consultar (red, 5xx, limite de uso) no es un fallo del video: sigue esperando", async () => {
    stub(() => new Error("red caida"));
    expect(await advanceVideoPublication(base({ remoteId: "C1", remoteStartedAt: NOW }))).toMatchObject({ kind: "waiting" });
    stub(() => ({ body: { error: { message: "limite", code: 4 } }, status: 400 }));
    expect(await advanceVideoPublication(base({ remoteId: "C1", remoteStartedAt: NOW }))).toMatchObject({ kind: "waiting" });
    stub(() => ({ body: { error: { message: "caido" } }, status: 503 }));
    expect(await advanceVideoPublication(base({ remoteId: "C1", remoteStartedAt: NOW }))).toMatchObject({ kind: "waiting" });
  });

  it("un permiso que falta al consultar si se lanza (el que llama lo clasifica)", async () => {
    stub(() => ({ body: { error: { message: "Requires instagram_content_publish", code: 200 } }, status: 403 }));
    await expect(advanceVideoPublication(base({ remoteId: "C1", remoteStartedAt: NOW }))).rejects.toBeInstanceOf(MetaApiError);
  });

  it("si publicar falla sin respuesta clara NO se reintenta solo (podria haber salido y se duplicaria)", async () => {
    stub((c) => (c.url.pathname.endsWith("/media_publish") ? new Error("red caida") : { body: { status_code: "FINISHED" } }));
    const err = await advanceVideoPublication(base({ remoteId: "C1", remoteStartedAt: NOW })).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).retryable).toBe(false);
    expect((err as PublishError).message).toMatch(/No se pudo confirmar si Instagram publicó el video/);

    stub((c) => (c.url.pathname.endsWith("/media_publish") ? { body: { error: { message: "unknown", code: 2 } }, status: 500 } : { body: { status_code: "FINISHED" } }));
    const err2 = await advanceVideoPublication(base({ remoteId: "C1", remoteStartedAt: NOW })).catch((e) => e);
    expect((err2 as PublishError).retryable).toBe(false);
  });

  it("un rechazo claro al publicar (permisos, limite) se lanza tal cual para clasificarlo", async () => {
    stub((c) => (c.url.pathname.endsWith("/media_publish") ? { body: { error: { message: "limite diario", code: 9, error_subcode: 2207042 } }, status: 400 } : { body: { status_code: "FINISHED" } }));
    await expect(advanceVideoPublication(base({ remoteId: "C1", remoteStartedAt: NOW }))).rejects.toBeInstanceOf(MetaApiError);
  });

  it("lleva demasiado procesando: se da por fallido y se pide revisar", async () => {
    stub(() => ({ body: { status_code: "IN_PROGRESS" } }));
    const old = new Date(NOW.getTime() - VIDEO_MAX_PROCESSING_MS - 1000);
    const step = await advanceVideoPublication(base({ remoteId: "C1", remoteStartedAt: old }));
    expect(step).toMatchObject({ kind: "failed", retryable: false, message: expect.stringMatching(/45 minutos.*Revisa en Instagram/) });
  });
});

describe("Facebook: Reel y historia con video", () => {
  const fb = (over: Partial<AdvanceInput> = {}) => base({ instagram: false, video: video({ publicUrl: "", coverUrl: null }), ...over });
  const UPLOAD = "https://rupload.facebook.com/video-upload/v26.0/V1";

  /** Meta simulado minimo para la subida completa. */
  const happy = (c: Call) => {
    if (c.url.pathname.endsWith("/video_reels") || c.url.pathname.endsWith("/video_stories")) {
      return c.form.upload_phase === "start" ? { body: { video_id: "V1", upload_url: UPLOAD } } : { body: { success: true, ...(c.url.pathname.endsWith("video_stories") ? { post_id: "P7" } : {}) } };
    }
    if (c.url.host === "rupload.facebook.com") return { body: { success: true } };
    return { body: {} };
  };

  it("fase 1 de un Reel: abre la subida, sube los bytes con las cabeceras de Meta, finaliza con la descripcion y queda esperando", async () => {
    const calls = stub(happy);
    const step = await advanceVideoPublication(fb());
    expect(step).toEqual({ kind: "waiting", remoteId: "V1", delaySeconds: VIDEO_POLL_SECONDS });

    expect(calls.map((c) => `${c.method} ${c.url.host}${c.url.pathname}`)).toEqual([
      "POST graph.facebook.com/v26.0/ACC1/video_reels",
      "POST rupload.facebook.com/video-upload/v26.0/V1",
      "POST graph.facebook.com/v26.0/ACC1/video_reels",
    ]);
    expect(calls[0].form).toMatchObject({ upload_phase: "start" });
    // El token de la pagina va en la cabecera de la subida (no en la URL), con el tamano y el desplazamiento.
    expect(calls[1].headers).toMatchObject({ authorization: "OAuth PAGE-TOKEN", offset: "0", file_size: "1000" });
    expect(calls[1].url.search).toBe("");
    expect(calls[1].bodyLength).toBe(1000);
    expect(calls[2].form).toMatchObject({ upload_phase: "finish", video_id: "V1", video_state: "PUBLISHED", description: "Mira nuestro nuevo video\n\nhttps://reservi.example" });
  });

  it("una historia con video usa video_stories, sin descripcion, y guarda tambien el id de su publicacion", async () => {
    const calls = stub(happy);
    const step = await advanceVideoPublication(fb({ story: true }));
    expect(step).toEqual({ kind: "waiting", remoteId: "V1|P7", delaySeconds: VIDEO_POLL_SECONDS });
    expect(calls[0].url.pathname).toBe("/v26.0/ACC1/video_stories");
    expect(calls[2].form).toMatchObject({ upload_phase: "finish", video_id: "V1" });
    expect(calls[2].form).not.toHaveProperty("description");
    expect(calls[2].form).not.toHaveProperty("video_state");
  });

  it("fase 2: processing sigue esperando; con el video ya publicado devuelve el enlace del Reel", async () => {
    stub(() => ({ body: { status: { video_status: "processing", publishing_phase: { status: "in_progress" } } } }));
    expect(await advanceVideoPublication(fb({ remoteId: "V1", remoteStartedAt: NOW }))).toMatchObject({ kind: "waiting" });

    const calls = stub(() => ({ body: { status: { video_status: "ready", publishing_phase: { status: "complete", publish_status: "published" } } } }));
    const step = await advanceVideoPublication(fb({ remoteId: "V1", remoteStartedAt: NOW }));
    expect(step).toEqual({ kind: "published", result: { externalId: "V1", url: "https://www.facebook.com/reel/V1" } });
    expect(calls[0].url.pathname).toBe("/v26.0/V1");
    expect(calls[0].url.searchParams.get("fields")).toBe("status");
  });

  it("una historia ya publicada usa el id de su publicacion y busca su enlace en /stories", async () => {
    const calls = stub((c) =>
      c.url.pathname.endsWith("/stories")
        ? { body: { data: [{ post_id: "P7", url: "https://www.facebook.com/stories/123/abc" }] } }
        : { body: { status: { video_status: "ready", publishing_phase: { status: "completed" } } } },
    );
    const step = await advanceVideoPublication(fb({ story: true, remoteId: "V1|P7", remoteStartedAt: NOW }));
    expect(step).toEqual({ kind: "published", result: { externalId: "P7", url: "https://www.facebook.com/stories/123/abc" } });
    expect(calls[0].url.pathname).toBe("/v26.0/V1");
  });

  it("si Facebook rechaza el video al procesarlo, se da por fallido con su motivo", async () => {
    stub(() => ({ body: { status: { video_status: "error", processing_phase: { status: "error", error: { message: "Resolution too low. Video must have a minimum resolution of 540p." } } } } }));
    const step = await advanceVideoPublication(fb({ remoteId: "V1", remoteStartedAt: NOW }));
    expect(step).toMatchObject({ kind: "failed", retryable: false, message: expect.stringMatching(/Facebook rechazó el video: Resolution too low/) });
  });

  it("finalizar sin respuesta clara NO se reintenta solo: Facebook pudo haberlo recibido", async () => {
    stub((c) => (c.form.upload_phase === "finish" ? new Error("red caida") : happy(c)));
    const err = await advanceVideoPublication(fb()).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).retryable).toBe(false);
    expect((err as PublishError).message).toMatch(/No se pudo confirmar si Facebook recibió el video/);

    stub((c) => (c.form.upload_phase === "finish" ? { body: {} } : happy(c)));
    const err2 = await advanceVideoPublication(fb()).catch((e) => e);
    expect((err2 as PublishError).retryable).toBe(false);
  });

  it("un fallo al subir los bytes antes de finalizar si se puede reintentar (no salio nada)", async () => {
    stub((c) => (c.url.host === "rupload.facebook.com" ? new Error("red caida") : happy(c)));
    const err = await advanceVideoPublication(fb()).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(classifyPublishError(err, { video: true })).toMatchObject({ retryable: true });
  });

  it("no manda el token a una direccion de subida que no es de Meta", async () => {
    const calls = stub((c) => (c.url.pathname.endsWith("/video_reels") ? { body: { video_id: "V1", upload_url: "https://evil.example.com/steal" } } : { body: { success: true } }));
    const err = await advanceVideoPublication(fb()).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect((err as PublishError).retryable).toBe(false);
    expect(calls).toHaveLength(1); // solo el "start": nada salio hacia el otro servidor
  });
});

describe("mensajes de error de video", () => {
  it("los rechazos de Facebook para un video dicen que arreglar y no se reintentan", () => {
    const c = classifyPublishError(new MetaApiError({ message: "x", code: 1363128, status: 400 }), { video: true });
    expect(c).toMatchObject({ retryable: false, message: expect.stringMatching(/Facebook rechazó el video: su duración/) });
    expect(classifyPublishError(new MetaApiError({ message: "x", code: 1363127, status: 400 }))).toMatchObject({ message: expect.stringMatching(/540 × 960/) });
  });

  it("Instagram: formato no soportado y descarga fallida hablan del video", () => {
    expect(classifyPublishError(new MetaApiError({ message: "x", code: 352, subcode: 2207026, status: 400 }), { video: true }).message).toMatch(/formato de este video/);
    const dl = classifyPublishError(new MetaApiError({ message: "x", code: 9004, subcode: 2207052, status: 400 }), { video: true });
    expect(dl).toMatchObject({ retryable: true, message: expect.stringMatching(/no pudo descargar el video/) });
    // Sin video el mensaje de siempre no cambia.
    expect(classifyPublishError(new MetaApiError({ message: "x", code: 9004, subcode: 2207052, status: 400 })).message).toMatch(/no pudo descargar la imagen/);
  });

  it("publicMediaUrl nombra lo que Instagram descarga", async () => {
    // APP_URL = http://localhost:3000 (setMetaEnv): Instagram no podria bajarlo.
    expect(() => publicMediaUrl("a.mp4", "el video")).toThrow(/Instagram descarga el video desde internet/);
    expect(() => publicMediaUrl("a.jpg")).toThrow(/Instagram descarga la imagen desde internet/);
    setMetaEnv({ APP_URL: "https://app.example.com" });
    vi.resetModules();
    const mod = await import("@/lib/meta/publish");
    expect(mod.publicMediaUrl("a.mp4", "el video")).toBe("https://app.example.com/media/a.mp4");
  });
});

describe("estado de la publicacion con un video en proceso", () => {
  it("un destino pendiente con su id guardado cuenta como publicandose; sin id sigue siendo programada", () => {
    expect(derivePostStatus([{ status: "PENDING", waiting: true }])).toBe("PUBLISHING");
    expect(derivePostStatus([{ status: "PENDING", waiting: false }])).toBe("SCHEDULED");
    expect(derivePostStatus([{ status: "PENDING" }])).toBe("SCHEDULED");
    expect(derivePostStatus([{ status: "PUBLISHED" }, { status: "PENDING", waiting: true }])).toBe("PUBLISHING");
    expect(derivePostStatus([{ status: "FAILED", waiting: true }])).toBe("FAILED");
  });
});
