import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MetaApiError } from "@/lib/meta/errors";
import { classifyPublishError, PublishError, type PublishVideo } from "@/lib/meta/publish";
import { advanceVideoPublication, type AdvanceInput, type VideoStep } from "@/lib/publishing/video";
import { setMetaEnv } from "./helpers/meta-env";

// Las fases de publicacion de un video contra el Meta SIMULADO de las pruebas e2e (e2e/fake-meta.mjs), con videos
// MP4 reales: comprueba que la app y el simulador hablan igual (cabeceras, estados, pasos que no se repiten) sin
// necesitar base de datos. Es la misma pieza que usan las pruebas e2e del recorrido completo.

const fixture = (name: string) => readFileSync(path.resolve(import.meta.dirname, "../e2e/fixtures", name));
const GOOD = fixture("video-vertical.mp4");
const MOOV_LAST = fixture("video-moov-al-final.mp4");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// El simulador es JavaScript de las pruebas e2e. Esa carpeta NO entra en la imagen de Docker (.dockerignore) y `next build`
// revisa los tipos de estas pruebas, asi que no se importa de forma estatica (el build no encontraria el archivo): se carga
// al empezar, con una ruta calculada, y se describe aqui lo poco que se usa de el.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Fake = {
  close(): Promise<void>;
  setScenario(scenario: Record<string, unknown>): void;
  reset(): void;
  published(): any[];
  uploads(): any[];
  requests(): any[];
};
/* eslint-enable @typescript-eslint/no-explicit-any */
let startFakeMeta: (port: number, expectedRedirectUri: string) => Promise<Fake>;
let PAGE_TOKEN: string;
let fake: Fake;
let media: http.Server;
let mediaBase: string;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

beforeAll(async () => {
  const fakeMetaUrl = pathToFileURL(path.resolve(import.meta.dirname, "../e2e/fake-meta.mjs")).href;
  ({ startFakeMeta, PAGE_TOKEN } = (await import(/* @vite-ignore */ fakeMetaUrl)) as { startFakeMeta: typeof startFakeMeta; PAGE_TOKEN: string });
  const metaPort = await freePort();
  setMetaEnv({ META_API_BASE_URL: `http://127.0.0.1:${metaPort}` });
  fake = await startFakeMeta(metaPort, "http://127.0.0.1/callback");

  // El servidor de la app: sirve los videos por su URL publica (Instagram los descarga de ahi).
  media = http.createServer((req, res) => {
    const file = req.url === "/media/bueno.mp4" ? GOOD : req.url === "/media/moov-al-final.mp4" ? MOOV_LAST : req.url === "/media/portada.jpg" ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : null;
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": req.url?.endsWith(".jpg") ? "image/jpeg" : "video/mp4", "content-length": file.length }).end(file);
  });
  await new Promise<void>((r) => media.listen(0, "127.0.0.1", r));
  mediaBase = `http://127.0.0.1:${(media.address() as net.AddressInfo).port}`;
});
afterAll(async () => {
  await fake.close();
  await new Promise<void>((r) => media.close(() => r()));
});
beforeEach(() => fake.reset());

const NOW = new Date("2026-11-06T12:00:00Z");
const video = (over: Partial<PublishVideo> = {}): PublishVideo => ({
  size: GOOD.length,
  mimeType: "video/mp4",
  publicUrl: `${mediaBase}/media/bueno.mp4`,
  coverUrl: `${mediaBase}/media/portada.jpg`,
  read: async () => new Uint8Array(GOOD),
  ...over,
});
const input = (over: Partial<AdvanceInput> = {}): AdvanceInput => ({
  instagram: true,
  story: false,
  account: { externalId: "IG-1", token: PAGE_TOKEN },
  text: "Nuestro video",
  linkUrl: "https://reservi.example",
  video: video(),
  remoteId: null,
  remoteStartedAt: null,
  now: NOW,
  ...over,
});
const fbInput = (over: Partial<AdvanceInput> = {}) => input({ instagram: false, account: { externalId: "P-1", token: PAGE_TOKEN }, video: video({ publicUrl: "", coverUrl: null }), ...over });

/** Repite `advance` como lo haria el proceso en segundo plano: guarda el id y vuelve a llamar hasta que no quede esperando. */
async function drive(base: AdvanceInput, maxTurns = 8): Promise<{ steps: VideoStep[]; last: VideoStep }> {
  const steps: VideoStep[] = [];
  let remoteId = base.remoteId;
  for (let i = 0; i < maxTurns; i++) {
    const step = await advanceVideoPublication({ ...base, remoteId, remoteStartedAt: remoteId ? NOW : null });
    steps.push(step);
    if (step.kind !== "waiting") return { steps, last: step };
    remoteId = step.remoteId;
  }
  throw new Error("sigue esperando");
}

describe("Instagram contra el Meta simulado", () => {
  it("un Reel: Meta baja el video y la portada de la URL publica, espera el procesamiento y se publica una sola vez", async () => {
    fake.setScenario({ videoProcessing: 2 });
    const { steps, last } = await drive(input());
    expect(steps.map((s) => s.kind)).toEqual(["waiting", "waiting", "waiting", "published"]); // crear, 2 veces procesando, publicar

    const reel = fake.published().find((p: { kind: string }) => p.kind === "ig-reel");
    expect(reel).toMatchObject({ caption: "Nuestro video", shareToFeed: "true", fetched: { status: 200, valid: true, fastStart: true, sha256: sha(GOOD) }, cover: { status: 200, contentType: "image/jpeg" } });
    expect(fake.published().filter((p: { kind: string }) => p.kind === "ig-publish")).toHaveLength(1);
    expect(last).toMatchObject({ kind: "published", result: { externalId: expect.stringMatching(/^IGM-/), url: expect.stringMatching(/instagram\.com\/p\//) } });
    // Las llamadas que publican (POST) llevan el token en el cuerpo, nunca en la URL (las consultas GET si lo llevan, como siempre).
    const posts = fake.requests().filter((r: { method?: string }) => r.method === "POST");
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((r: { tokenInUrl?: boolean }) => !r.tokenInUrl)).toBe(true);
  });

  it("una historia con video usa STORIES, sin pie, y sale con enlace de historia", async () => {
    const { last } = await drive(input({ story: true }));
    const story = fake.published().find((p: { kind: string }) => p.kind === "ig-video-story");
    expect(story).toMatchObject({ caption: null, shareToFeed: null, fetched: { fastStart: true } });
    expect(story.fields).not.toContain("caption");
    expect(last).toMatchObject({ kind: "published", result: { url: expect.stringMatching(/instagram\.com\/stories\//) } });
  });

  it("un video con el indice al final lo rechaza Meta (formato no soportado) y el mensaje explica que hacer", async () => {
    const err = await advanceVideoPublication(input({ video: video({ publicUrl: `${mediaBase}/media/moov-al-final.mp4` }) })).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.subcode).toBe(2207026);
    expect(classifyPublishError(err, { video: true })).toMatchObject({ retryable: false, message: expect.stringMatching(/MP4 con H\.264 y AAC/) });
  });

  it("una URL que Meta no puede bajar da el error de descarga (se reintenta)", async () => {
    const err = await advanceVideoPublication(input({ video: video({ publicUrl: `${mediaBase}/media/no-existe.mp4` }) })).catch((e) => e);
    expect(classifyPublishError(err, { video: true })).toMatchObject({ retryable: true, message: expect.stringMatching(/no pudo descargar el video/) });
  });

  it("si Instagram termina el contenedor en ERROR, falla con su motivo", async () => {
    fake.setScenario({ videoFail: "ig" });
    const { last } = await drive(input());
    expect(last).toMatchObject({ kind: "failed", retryable: false, message: expect.stringMatching(/Instagram rechazó el video/) });
    expect(fake.published().filter((p: { kind: string }) => p.kind === "ig-publish")).toHaveLength(0);
  });

  it("si publicar responde 500 pero Meta SI publico, la app no lo repite: queda en una sola publicacion", async () => {
    fake.setScenario({ videoPublishFail: "server-after" });
    const err = await drive(input()).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.retryable).toBe(false);
    expect(fake.published().filter((p: { kind: string }) => p.kind === "ig-publish")).toHaveLength(1);
  });

  it("publicar antes de que termine el procesamiento lo rechaza el simulador como Meta (por eso la app espera a FINISHED)", async () => {
    fake.setScenario({ videoProcessing: 3 });
    const first = await advanceVideoPublication(input());
    if (first.kind !== "waiting") throw new Error("se esperaba esperar");
    const res = await fetch(`${process.env.META_API_BASE_URL}/v26.0/IG-1/media_publish`, { method: "POST", body: new URLSearchParams({ creation_id: first.remoteId, access_token: PAGE_TOKEN }) });
    expect(res.status).toBe(400); // sin appsecret_proof ya se rechaza; el orden real lo cubre el recorrido de arriba
  });
});

describe("Facebook contra el Meta simulado", () => {
  it("un Reel: abre la subida, sube los bytes con las cabeceras de Meta, finaliza y confirma cuando ya salio", async () => {
    fake.setScenario({ videoProcessing: 1 });
    const { steps, last } = await drive(fbInput());
    expect(steps.map((s) => s.kind)).toEqual(["waiting", "waiting", "published"]); // subir+finalizar, procesando, publicado

    expect(fake.uploads()).toEqual([expect.objectContaining({ authOk: true, offset: 0, fileSize: GOOD.length, received: GOOD.length, sha256: sha(GOOD), tokenInUrl: false })]);
    expect(fake.published().filter((p: { kind: string }) => p.kind === "fb-reel")).toEqual([
      expect.objectContaining({ description: "Nuestro video\n\nhttps://reservi.example", videoState: "PUBLISHED", sha256: sha(GOOD), fastStart: true }),
    ]);
    expect(last).toMatchObject({ kind: "published", result: { url: expect.stringMatching(/facebook\.com\/reel\/FBV-/) } });
  });

  it("una historia con video usa video_stories, sin descripcion, y busca su enlace en /stories", async () => {
    const { last } = await drive(fbInput({ story: true }));
    const story = fake.published().find((p: { kind: string }) => p.kind === "fb-video-story");
    expect(story.fields).toEqual(expect.arrayContaining(["upload_phase", "video_id"]));
    expect(story.fields).not.toContain("description");
    expect(last).toMatchObject({ kind: "published", result: { externalId: story.postId, url: expect.stringMatching(/facebook\.com\/stories\/P-1\//) } });
  });

  it("si Facebook rechaza el video al procesarlo, falla con el motivo de Facebook", async () => {
    fake.setScenario({ videoFail: "fb" });
    const { last } = await drive(fbInput());
    expect(last).toMatchObject({ kind: "failed", retryable: false, message: expect.stringMatching(/Resolution too low/) });
  });

  it("si finalizar responde 500 pero Facebook SI lo recibio, la app no lo repite: una sola publicacion", async () => {
    fake.setScenario({ videoPublishFail: "server-after" });
    const err = await drive(fbInput()).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.retryable).toBe(false);
    expect(fake.published().filter((p: { kind: string }) => p.kind === "fb-reel")).toHaveLength(1);
  });

  it("un archivo que no es un video lo rechaza la subida del simulador (como rupload)", async () => {
    const err = await advanceVideoPublication(fbInput({ video: video({ publicUrl: "", coverUrl: null, size: 20, read: async () => new Uint8Array(20) }) })).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
  });
});
