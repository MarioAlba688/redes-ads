import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaApiError } from "@/lib/meta/errors";
import {
  backoffMinutes,
  classifyPublishError,
  MAX_PUBLISH_ATTEMPTS,
  PublishError,
  publicMediaUrl,
  publishToFacebookPage,
  publishToInstagram,
} from "@/lib/meta/publish";
import { setMetaEnv } from "./helpers/meta-env";

beforeEach(() => setMetaEnv());
afterEach(() => vi.unstubAllGlobals());

const page = { externalId: "P1", token: "PAGE-TOKEN" };
const ig = { externalId: "IG1", token: "PAGE-TOKEN" };
const image = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", filename: "imagen.jpg", publicUrl: "https://app.example.com/media/x.jpg" };

/** Cuerpo (formulario) que recibio una llamada POST del publicador. */
async function bodyOf(init: RequestInit | undefined) {
  const b = init?.body;
  if (b instanceof URLSearchParams) return Object.fromEntries(b);
  if (b instanceof FormData) return Object.fromEntries([...b.entries()].map(([k, v]) => [k, v instanceof File ? `[archivo ${v.name} ${v.type} ${v.size}B]` : v]));
  return {};
}

function stubFetchWithBodies(handler: (url: URL, n: number) => { body: unknown; status?: number } | Error) {
  const calls: { url: URL; init?: RequestInit; form: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const form = await bodyOf(init);
      calls.push({ url, init, form });
      const r = handler(url, calls.length);
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

describe("publicar en una pagina de Facebook", () => {
  it("un texto va a /feed con el mensaje y el enlace, y el token en el cuerpo (no en la URL)", async () => {
    const calls = stubFetchWithBodies(() => ({ body: { id: "P1_555" } }));
    const res = await publishToFacebookPage(page, { text: "Hola mundo", linkUrl: "https://reservi.example", images: [] });

    expect(res).toEqual({ externalId: "P1_555", url: "https://www.facebook.com/P1_555" });
    const c = calls[0];
    expect(c.init?.method).toBe("POST");
    expect(c.url.pathname).toBe("/v26.0/P1/feed");
    expect(c.url.search).toBe(""); // nada sensible en la URL
    expect(c.form).toMatchObject({ message: "Hola mundo", link: "https://reservi.example", access_token: "PAGE-TOKEN" });
    expect(String(c.form.appsecret_proof)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sin enlace no manda el campo link", async () => {
    const calls = stubFetchWithBodies(() => ({ body: { id: "P1_1" } }));
    await publishToFacebookPage(page, { text: "Solo texto", linkUrl: null, images: [] });
    expect(calls[0].form).not.toHaveProperty("link");
  });

  it("con imagen sube la foto a /photos como archivo y el texto va de pie (con el enlace al final)", async () => {
    const calls = stubFetchWithBodies(() => ({ body: { id: "999", post_id: "P1_999" } }));
    const res = await publishToFacebookPage(page, { text: "Mira esto", linkUrl: "https://reservi.example", images: [image] });

    expect(res.externalId).toBe("P1_999");
    const c = calls[0];
    expect(c.url.pathname).toBe("/v26.0/P1/photos");
    expect(c.init?.body).toBeInstanceOf(FormData);
    expect(c.form.source).toBe("[archivo imagen.jpg image/jpeg 3B]");
    expect(c.form.caption).toBe("Mira esto\n\nhttps://reservi.example");
    expect(c.form.published).toBe("true");
  });

  it("si Meta rechaza, el error es un MetaApiError con su codigo", async () => {
    stubFetchWithBodies(() => ({ status: 403, body: { error: { message: "(#200) Requires pages_manage_posts", code: 200 } } }));
    const err = await publishToFacebookPage(page, { text: "x", linkUrl: null, images: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.code).toBe(200);
  });
});

describe("publicar en Facebook con varias imagenes", () => {
  const img = (name: string) => ({ ...image, filename: `${name}.jpg` });

  it("sube cada foto SIN publicar y en orden, y crea una sola publicacion que las adjunta (con el enlace al final del texto)", async () => {
    let n = 0;
    const calls = stubFetchWithBodies((url) => {
      if (url.pathname.endsWith("/P1/photos")) return { body: { id: `PH-${++n}` } };
      if (url.pathname.endsWith("/P1/feed")) return { body: { id: "P1_700" } };
      return { status: 404, body: { error: { message: "no", code: 803 } } };
    });
    const res = await publishToFacebookPage(page, { text: "Álbum nuevo", linkUrl: "https://reservi.example", images: [img("a"), img("b"), img("c")] });

    expect(res).toEqual({ externalId: "P1_700", url: "https://www.facebook.com/P1_700" });
    expect(calls.map((c) => c.url.pathname.replace("/v26.0/", ""))).toEqual(["P1/photos", "P1/photos", "P1/photos", "P1/feed"]);
    calls.slice(0, 3).forEach((c, i) => {
      expect(c.form.source).toBe(`[archivo ${"abc"[i]}.jpg image/jpeg 3B]`);
      expect(c.form.published).toBe("false"); // si se publicaran solas saldrian como tres publicaciones sueltas
      expect(c.form).not.toHaveProperty("caption");
    });
    const feed = calls[3].form;
    expect(feed.message).toBe("Álbum nuevo\n\nhttps://reservi.example");
    expect(feed).not.toHaveProperty("link"); // con fotos adjuntas el enlace va dentro del texto
    expect(JSON.parse(String(feed["attached_media[0]"]))).toEqual({ media_fbid: "PH-1" });
    expect(JSON.parse(String(feed["attached_media[1]"]))).toEqual({ media_fbid: "PH-2" });
    expect(JSON.parse(String(feed["attached_media[2]"]))).toEqual({ media_fbid: "PH-3" });
    expect(String(feed.access_token)).toBe("PAGE-TOKEN");
  });

  it("si falla la subida de una foto no se crea la publicacion", async () => {
    let n = 0;
    const calls = stubFetchWithBodies(() => (++n === 2 ? { status: 400, body: { error: { message: "(#100) Invalid image", code: 100 } } } : { body: { id: `PH-${n}` } }));
    const err = await publishToFacebookPage(page, { text: "x", linkUrl: null, images: [img("a"), img("b"), img("c")] }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.pathname.endsWith("/feed"))).toBe(false);
  });

  it("mas de 10 imagenes ni siquiera llama a Meta", async () => {
    const calls = stubFetchWithBodies(() => ({ body: {} }));
    const err = await publishToFacebookPage(page, { text: "x", linkUrl: null, images: Array.from({ length: 11 }, (_, i) => img(String(i))) }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("publicar un carrusel en Instagram", () => {
  const img = (name: string) => ({ ...image, publicUrl: `https://app.example.com/media/${name}.jpg` });

  it("crea un contenedor por imagen (hijos), uno padre que los reune en orden, y publica el padre", async () => {
    let media = 0;
    const calls = stubFetchWithBodies((url) => {
      if (url.pathname.endsWith("/IG1/media")) return { body: { id: ++media <= 3 ? `CH-${media}` : "PADRE" } };
      if (/\/(CH-\d|PADRE)$/.test(url.pathname)) return { body: { status_code: "FINISHED" } };
      if (url.pathname.endsWith("/IG1/media_publish")) return { body: { id: "MEDIA-5" } };
      if (url.pathname.endsWith("/MEDIA-5")) return { body: { permalink: "https://www.instagram.com/p/CAR/" } };
      return { status: 404, body: { error: { message: "no", code: 803 } } };
    });
    const res = await publishToInstagram(ig, { text: "Carrusel #reservi", linkUrl: null, images: [img("a"), img("b"), img("c")] }, { pollMs: 0 });

    expect(res).toEqual({ externalId: "MEDIA-5", url: "https://www.instagram.com/p/CAR/" });
    expect(calls.map((c) => c.url.pathname.replace("/v26.0/", ""))).toEqual([
      "IG1/media", "IG1/media", "IG1/media", "CH-1", "CH-2", "CH-3", "IG1/media", "PADRE", "IG1/media_publish", "MEDIA-5",
    ]);
    ["a", "b", "c"].forEach((name, i) => {
      expect(calls[i].form).toMatchObject({ image_url: `https://app.example.com/media/${name}.jpg`, is_carousel_item: "true" });
      expect(calls[i].form).not.toHaveProperty("caption"); // el pie va en el contenedor padre, no en cada hijo
    });
    expect(calls[6].form).toMatchObject({ media_type: "CAROUSEL", children: "CH-1,CH-2,CH-3", caption: "Carrusel #reservi" });
    expect(calls[8].form).toMatchObject({ creation_id: "PADRE" });
  });

  it("si Instagram rechaza una de las imagenes, falla sin publicar y sin reintento", async () => {
    let media = 0;
    const calls = stubFetchWithBodies((url) => {
      if (url.pathname.endsWith("/IG1/media")) return { body: { id: `CH-${++media}` } };
      if (url.pathname.endsWith("/CH-2")) return { body: { status_code: "ERROR", status: "Error: Invalid image" } };
      return { body: { status_code: "FINISHED" } };
    });
    const err = await publishToInstagram(ig, { text: "x", linkUrl: null, images: [img("a"), img("b")] }, { pollMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/rechazó una de las imágenes/);
    expect(calls.some((c) => c.url.pathname.endsWith("media_publish"))).toBe(false);
  });

  it("si el carrusel nunca termina de procesarse, se puede reintentar", async () => {
    let media = 0;
    stubFetchWithBodies((url) => {
      if (url.pathname.endsWith("/IG1/media")) return { body: { id: ++media <= 2 ? `CH-${media}` : "PADRE" } };
      if (url.pathname.endsWith("/PADRE")) return { body: { status_code: "IN_PROGRESS" } };
      return { body: { status_code: "FINISHED" } };
    });
    const err = await publishToInstagram(ig, { text: "x", linkUrl: null, images: [img("a"), img("b")] }, { pollMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/el carrusel/);
  });

  it("mas de 10 imagenes ni siquiera llama a Meta", async () => {
    const calls = stubFetchWithBodies(() => ({ body: {} }));
    const err = await publishToInstagram(ig, { text: "x", linkUrl: null, images: Array.from({ length: 11 }, (_, i) => img(String(i))) }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(calls).toHaveLength(0);
  });
});

describe("publicar en Instagram", () => {
  it("crea el contenedor con la URL publica, espera a que termine y lo publica", async () => {
    const calls = stubFetchWithBodies((url) => {
      if (url.pathname.endsWith("/IG1/media")) return { body: { id: "CONT-1" } };
      if (url.pathname.endsWith("/CONT-1")) return { body: { status_code: "FINISHED" } };
      if (url.pathname.endsWith("/IG1/media_publish")) return { body: { id: "MEDIA-9" } };
      if (url.pathname.endsWith("/MEDIA-9")) return { body: { permalink: "https://www.instagram.com/p/ABC/" } };
      return { status: 404, body: { error: { message: "no", code: 803 } } };
    });
    const res = await publishToInstagram(ig, { text: "Pie de foto #reservi", linkUrl: null, images: [image] }, { pollMs: 0 });

    expect(res).toEqual({ externalId: "MEDIA-9", url: "https://www.instagram.com/p/ABC/" });
    expect(calls.map((c) => c.url.pathname.replace("/v26.0/", ""))).toEqual(["IG1/media", "CONT-1", "IG1/media_publish", "MEDIA-9"]);
    expect(calls[0].form).toMatchObject({ image_url: "https://app.example.com/media/x.jpg", caption: "Pie de foto #reservi" });
    expect(calls[2].form).toMatchObject({ creation_id: "CONT-1" });
  });

  it("espera mientras el contenedor esta en proceso", async () => {
    let polls = 0;
    stubFetchWithBodies((url) => {
      if (url.pathname.endsWith("/IG1/media")) return { body: { id: "C" } };
      if (url.pathname.endsWith("/C")) return { body: { status_code: ++polls < 3 ? "IN_PROGRESS" : "FINISHED" } };
      if (url.pathname.endsWith("/media_publish")) return { body: { id: "M" } };
      return { body: {} };
    });
    const res = await publishToInstagram(ig, { text: "x", linkUrl: null, images: [image] }, { pollMs: 0 });
    expect(res.externalId).toBe("M");
    expect(polls).toBe(3);
  });

  it("si Instagram rechaza la imagen (ERROR), falla sin publicar y sin reintento", async () => {
    const calls = stubFetchWithBodies((url) => {
      if (url.pathname.endsWith("/IG1/media")) return { body: { id: "C" } };
      return { body: { status_code: "ERROR", status: "Error: Invalid image" } };
    });
    const err = await publishToInstagram(ig, { text: "x", linkUrl: null, images: [image] }, { pollMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/rechazó la imagen/);
    expect(calls.some((c) => c.url.pathname.endsWith("media_publish"))).toBe(false);
  });

  it("si el contenedor nunca termina, falla con un error que se puede reintentar", async () => {
    stubFetchWithBodies((url) => (url.pathname.endsWith("/IG1/media") ? { body: { id: "C" } } : { body: { status_code: "IN_PROGRESS" } }));
    const err = await publishToInstagram(ig, { text: "x", linkUrl: null, images: [image] }, { pollMs: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.retryable).toBe(true);
  });

  it("sin imagen ni siquiera llama a Meta", async () => {
    const calls = stubFetchWithBodies(() => ({ body: {} }));
    const err = await publishToInstagram(ig, { text: "x", linkUrl: null, images: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(calls).toHaveLength(0);
  });

  it("si no se puede leer el permalink, la publicacion igual cuenta como hecha", async () => {
    stubFetchWithBodies((url) => {
      if (url.pathname.endsWith("/IG1/media")) return { body: { id: "C" } };
      if (url.pathname.endsWith("/C")) return { body: { status_code: "FINISHED" } };
      if (url.pathname.endsWith("/media_publish")) return { body: { id: "M" } };
      return { status: 400, body: { error: { message: "x", code: 100 } } };
    });
    const res = await publishToInstagram(ig, { text: "x", linkUrl: null, images: [image] }, { pollMs: 0 });
    expect(res.externalId).toBe("M");
    expect(res.url).toBe("https://www.instagram.com/");
  });
});

describe("URL publica de las imagenes", () => {
  it("con APP_URL https publico, arma la URL de /media", async () => {
    setMetaEnv({ APP_URL: "https://app.mimarca.co" });
    vi.resetModules();
    const mod = await import("@/lib/meta/publish");
    expect(mod.publicMediaUrl("abc.jpg")).toBe("https://app.mimarca.co/media/abc.jpg");
  });

  it("con APP_URL local o http avisa en lugar de mandar a Instagram una URL que no puede bajar", () => {
    expect(() => publicMediaUrl("abc.jpg")).toThrow(/no es accesible desde fuera/); // APP_URL = http://localhost:3000
  });

  it("MEDIA_PUBLIC_BASE_URL manda sobre APP_URL (pruebas o dominio aparte)", async () => {
    setMetaEnv({ MEDIA_PUBLIC_BASE_URL: "https://cdn.mimarca.co/" });
    vi.resetModules();
    const mod = await import("@/lib/meta/publish");
    expect(mod.publicMediaUrl("abc.jpg")).toBe("https://cdn.mimarca.co/media/abc.jpg");
  });
});

describe("clasificar errores", () => {
  const meta = (init: ConstructorParameters<typeof MetaApiError>[0]) => classifyPublishError(new MetaApiError(init));

  it("token vencido: no se reintenta y marca la cuenta como vencida", () => {
    expect(meta({ message: "x", code: 190, status: 400 })).toMatchObject({ retryable: false, expired: true });
  });

  it("limite de uso, caida de red y errores del servidor de Meta: se reintentan", () => {
    expect(meta({ message: "x", code: 4, status: 400 })).toMatchObject({ retryable: true, expired: false });
    expect(meta({ message: "x", network: true })).toMatchObject({ retryable: true });
    expect(meta({ message: "x", status: 503 })).toMatchObject({ retryable: true });
    expect(meta({ message: "x", code: 2, status: 500 })).toMatchObject({ retryable: true });
  });

  it("falta de permisos: no se reintenta y dice cuales", () => {
    const c = meta({ message: "(#200) perm", code: 200, status: 403 });
    expect(c.retryable).toBe(false);
    expect(c.message).toMatch(/pages_manage_posts.*instagram_content_publish/);
  });

  it("falta de permisos: incluye lo que dijo Meta para saber cual falta, acortado", () => {
    const c = meta({ message: "(#200) Requires pages_manage_posts permission to manage the object", code: 200, status: 403 });
    expect(c.message).toContain("Detalle de Meta: (#200) Requires pages_manage_posts permission to manage the object");
    expect(meta({ message: "(#200) " + "x".repeat(500), code: 200, status: 403 }).message.length).toBeLessThan(500);
  });

  it("Instagram no pudo descargar la imagen: se reintenta y explica que la app debe estar en internet", () => {
    const c = meta({ message: "Media download has failed", code: 1, subcode: 2207052, status: 400 });
    expect(c).toMatchObject({ retryable: true });
    expect(c.message).toMatch(/accesible desde internet/);
  });

  it("spam y duplicados: no se reintentan", () => {
    expect(meta({ message: "x", code: 368, status: 400 }).retryable).toBe(false);
    expect(meta({ message: "Duplicate status message", code: 506, status: 400 }).message).toMatch(/duplicado/);
  });

  it("un error desconocido de Meta no se reintenta y muestra un resumen corto", () => {
    const c = meta({ message: "z".repeat(500), code: 100, status: 400 });
    expect(c.retryable).toBe(false);
    expect(c.message.length).toBeLessThan(260);
  });

  it("los errores propios y los inesperados tambien se clasifican", () => {
    expect(classifyPublishError(new PublishError("sin imagen", false))).toEqual({ message: "sin imagen", retryable: false, expired: false });
    expect(classifyPublishError(new Error("boom"))).toMatchObject({ retryable: false });
  });
});

describe("reintentos", () => {
  it("espera 2, 10 y 30 minutos entre intentos", () => {
    expect([1, 2, 3].map(backoffMinutes)).toEqual([2, 10, 30]);
    expect(backoffMinutes(0)).toBe(2);
    expect(backoffMinutes(9)).toBe(30);
  });

  it("hace como mucho 4 intentos en total", () => {
    expect(MAX_PUBLISH_ATTEMPTS).toBe(4);
  });
});
