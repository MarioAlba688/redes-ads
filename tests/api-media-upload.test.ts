import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readVideoInfo, bytesSource, MAX_VIDEO_BYTES } from "@/lib/video-format";
import { buildMp4 } from "./helpers/mp4";
import { setMetaEnv } from "./helpers/meta-env";

// La ruta que recibe videos e imagenes de un borrador, llamada de verdad (sin base de datos: se simula) sobre una
// carpeta de medios temporal. Cubre lo que no se puede probar en e2e sin MySQL: cuerpo grande por partes, bytes
// declarados, indice al final, archivos que no son video y limpieza ante fallos.

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  audit: vi.fn(),
  postFind: vi.fn(),
  mediaCreate: vi.fn(),
  mediaAggregate: vi.fn(),
  mediaFind: vi.fn(),
  mediaUpdate: vi.fn(),
}));
vi.mock("@/lib/auth/dal", () => ({ authorize: h.authorize }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/db", () => ({
  db: { post: { findUnique: h.postFind }, postMedia: { create: h.mediaCreate, aggregate: h.mediaAggregate, findFirst: h.mediaFind, update: h.mediaUpdate } },
}));

let dir: string;
let route: typeof import("@/app/api/posts/[id]/media/route");
let cover: typeof import("@/app/api/posts/[id]/media/[mediaId]/cover/route");

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "redes-upload-"));
  setMetaEnv({ MEDIA_DIR: dir });
  route = await import("@/app/api/posts/[id]/media/route");
  cover = await import("@/app/api/posts/[id]/media/[mediaId]/cover/route");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  for (const f of await readdir(dir)) await rm(path.join(dir, f), { force: true });
  h.authorize.mockResolvedValue({ ok: true, user: { id: "u1" } });
  h.postFind.mockResolvedValue({ status: "DRAFT", format: "FEED", media: [] });
  h.mediaCreate.mockResolvedValue({ id: "m1" });
  h.mediaAggregate.mockResolvedValue({ _max: { position: null } });
});

const ctx = { params: Promise.resolve({ id: "p1" }) };

/** Una peticion de subida de video con el cuerpo como flujo, en trozos de 1 MB, con las cabeceras que manda el navegador. */
function videoRequest(bytes: Uint8Array, headers: Record<string, string | null> = {}) {
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.subarray(at, at + 1024 * 1024));
      at += 1024 * 1024;
    },
  });
  const all: Record<string, string | null> = { "content-type": "video/mp4", "content-length": String(bytes.length), "x-file-name": encodeURIComponent("mi video ñ.mp4"), ...headers };
  const map = new Map(Object.entries(all).filter(([, v]) => v !== null) as [string, string][]);
  return { headers: { get: (k: string) => map.get(k.toLowerCase()) ?? null }, body } as unknown as Parameters<typeof route.POST>[0];
}
const files = async () => (await readdir(dir)).sort();

describe("POST /api/posts/[id]/media con un video", () => {
  it("recibe un video de 25 MB completo (mas de lo que el proxy de Next dejaria pasar), lo reordena a fast start y lo registra", async () => {
    const video = buildMp4({ moovFirst: false, mdatBytes: 25 * 1024 * 1024, width: 1080, height: 1920, durationMs: 20_000 });
    const res = await route.POST(videoRequest(video), ctx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ id: "m1", kind: "VIDEO", width: 1080, height: 1920, durationMs: 20_000, optimized: true, warnings: [] });
    expect(json.url).toMatch(/^\/media\/[a-f0-9]{48}\.mp4$/);

    const [name] = await files();
    expect(await files()).toHaveLength(1);
    const stored = await readFile(path.join(dir, name));
    expect(stored.length).toBe(video.length);
    const info = await readVideoInfo(bytesSource(stored));
    expect(info.ok && info.info.fastStart).toBe(true);

    expect(h.mediaCreate).toHaveBeenCalledOnce();
    expect(h.mediaCreate.mock.calls[0][0].data).toMatchObject({
      postId: "p1",
      kind: "VIDEO",
      mimeType: "video/mp4",
      size: video.length,
      width: 1080,
      height: 1920,
      durationMs: 20_000,
      storageKey: name,
      originalName: "mi video ñ.mp4",
      position: 0,
      videoInfo: { videoCodec: "avc1", fastStart: true, audio: { codec: "mp4a" } },
    });
  });

  it("un video con el indice ya al inicio se guarda tal cual", async () => {
    const video = buildMp4({ moovFirst: true });
    const res = await route.POST(videoRequest(video), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ optimized: false });
    const [name] = await files();
    expect([...(await readFile(path.join(dir, name)))]).toEqual([...video]);
  });

  it("un MOV de QuickTime se guarda como .mov", async () => {
    const res = await route.POST(videoRequest(buildMp4({ brand: "qt  " }), { "content-type": "video/quicktime" }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).url).toMatch(/\.mov$/);
    expect(h.mediaCreate.mock.calls[0][0].data).toMatchObject({ mimeType: "video/quicktime" });
  });

  it("devuelve los avisos que no bloquean (no es vertical)", async () => {
    const res = await route.POST(videoRequest(buildMp4({ width: 1920, height: 1080 })), ctx);
    expect((await res.json()).warnings.join(" ")).toMatch(/9:16/);
  });

  it("rechaza una subida cortada: llegan menos bytes de los declarados y no queda nada en disco", async () => {
    const video = buildMp4({ mdatBytes: 5000 });
    const res = await route.POST(videoRequest(video.subarray(0, 3000), { "content-length": String(video.length) }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/incompleta/);
    expect(await files()).toEqual([]);
    expect(h.mediaCreate).not.toHaveBeenCalled();
  });

  it("rechaza lo que no es un video aunque se llame .mp4", async () => {
    const res = await route.POST(videoRequest(new TextEncoder().encode("esto es un texto cualquiera que no es un video en absoluto")), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no es un video/);
    expect(await files()).toEqual([]);
  });

  it("rechaza un video sin indice, sin recibir el cuerpo si pesa mas del tope o falta el tamano", async () => {
    expect((await route.POST(videoRequest(buildMp4({ noMoov: true })), ctx)).status).toBe(400);
    expect(await files()).toEqual([]);

    const big = videoRequest(new Uint8Array(10), { "content-length": String(MAX_VIDEO_BYTES + 1) });
    expect((await route.POST(big, ctx)).status).toBe(413);
    expect((await route.POST(videoRequest(buildMp4(), { "content-length": null }), ctx)).status).toBe(411);
    expect(await files()).toEqual([]);
  });

  it("no mezcla un video con imagenes ni con otro video, y solo en borradores", async () => {
    h.postFind.mockResolvedValue({ status: "DRAFT", format: "FEED", media: [{ kind: "IMAGE" }] });
    expect(await (await route.POST(videoRequest(buildMp4()), ctx)).json()).toMatchObject({ error: expect.stringMatching(/ya tiene imágenes/) });
    h.postFind.mockResolvedValue({ status: "DRAFT", format: "FEED", media: [{ kind: "VIDEO" }] });
    expect(await (await route.POST(videoRequest(buildMp4()), ctx)).json()).toMatchObject({ error: expect.stringMatching(/ya tiene un video/) });
    h.postFind.mockResolvedValue({ status: "SCHEDULED", format: "FEED", media: [] });
    expect((await route.POST(videoRequest(buildMp4()), ctx)).status).toBe(409);
    h.postFind.mockResolvedValue(null);
    expect((await route.POST(videoRequest(buildMp4()), ctx)).status).toBe(404);
    expect(await files()).toEqual([]);
  });

  it("sin sesion responde 401 antes de leer el cuerpo", async () => {
    h.authorize.mockResolvedValue({ ok: false, error: "Tu sesión expiró." });
    const req = videoRequest(buildMp4());
    expect((await route.POST(req, ctx)).status).toBe(401);
    expect(req.body!.locked).toBe(false);
  });

  it("si la base de datos falla al registrar, el archivo no queda huerfano", async () => {
    h.mediaCreate.mockRejectedValue(new Error("base caida"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await route.POST(videoRequest(buildMp4()), ctx);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(await files()).toEqual([]);
  });
});

describe("POST /api/posts/[id]/media con una imagen", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00]);
  const imageRequest = (bytes: Uint8Array) => {
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(bytes)], "foto.jpg", { type: "image/jpeg" }));
    return { headers: { get: () => null }, formData: async () => fd } as unknown as Parameters<typeof route.POST>[0];
  };

  it("sigue guardando una imagen como antes", async () => {
    const res = await route.POST(imageRequest(jpeg), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "m1", width: 16, height: 16 });
    expect(h.mediaCreate.mock.calls[0][0].data).not.toHaveProperty("kind");
  });

  it("no se suben imagenes a una publicacion que ya tiene video", async () => {
    h.postFind.mockResolvedValue({ status: "DRAFT", format: "FEED", media: [{ kind: "VIDEO" }] });
    const res = await route.POST(imageRequest(jpeg), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/ya tiene un video/);
  });
});

describe("POST /api/posts/[id]/media/[mediaId]/cover", () => {
  const cctx = { params: Promise.resolve({ id: "p1", mediaId: "m1" }) };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x07, 0x80, 0x04, 0x38, 0x01, 0x01, 0x11, 0x00]);
  const coverRequest = (bytes: Uint8Array, type = "image/jpeg") => {
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(bytes)], "portada.jpg", { type }));
    return { headers: { get: () => null }, formData: async () => fd } as unknown as Parameters<typeof cover.POST>[0];
  };

  it("guarda la portada de un video del borrador y quita la anterior", async () => {
    h.mediaFind.mockResolvedValue({ id: "m1", kind: "VIDEO", thumbKey: null, post: { status: "DRAFT" } });
    const res = await cover.POST(coverRequest(jpeg), cctx);
    expect(res.status).toBe(200);
    const [name] = await files();
    expect(name).toMatch(/\.jpg$/);
    expect(h.mediaUpdate).toHaveBeenCalledWith({ where: { id: "m1" }, data: { thumbKey: name } });

    h.mediaFind.mockResolvedValue({ id: "m1", kind: "VIDEO", thumbKey: name, post: { status: "DRAFT" } });
    expect((await cover.POST(coverRequest(jpeg), cctx)).status).toBe(200);
    expect(await files()).toHaveLength(1); // la vieja se borro
    expect((await files())[0]).not.toBe(name);
  });

  it("solo para videos de borradores y solo JPG", async () => {
    h.mediaFind.mockResolvedValue({ id: "m1", kind: "IMAGE", thumbKey: null, post: { status: "DRAFT" } });
    expect((await cover.POST(coverRequest(jpeg), cctx)).status).toBe(409);
    h.mediaFind.mockResolvedValue({ id: "m1", kind: "VIDEO", thumbKey: null, post: { status: "SCHEDULED" } });
    expect((await cover.POST(coverRequest(jpeg), cctx)).status).toBe(409);
    h.mediaFind.mockResolvedValue({ id: "m1", kind: "VIDEO", thumbKey: null, post: { status: "DRAFT" } });
    expect((await cover.POST(coverRequest(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), cctx)).status).toBe(400);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 8, 0, 0, 0, 8]);
    const res = await cover.POST(coverRequest(png, "image/png"), cctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/JPG/);
    expect(await files()).toEqual([]);
  });
});
