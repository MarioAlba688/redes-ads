import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { faststartLayout, readVideoInfo } from "@/lib/video-format";
import { buildMp4 } from "./helpers/mp4";
import { setMetaEnv } from "./helpers/meta-env";

// Entrada y salida de videos en disco (src/lib/media.ts) sobre una carpeta de medios temporal.

let dir: string;
let media: typeof import("@/lib/media");

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "redes-media-"));
  setMetaEnv({ MEDIA_DIR: dir });
  media = await import("@/lib/media");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const streamOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
const names = async () => (await readdir(dir)).sort();
const readAll = async (s: ReadableStream<Uint8Array>) => Buffer.concat(await Array.fromAsync(s as unknown as AsyncIterable<Uint8Array>));

describe("MEDIA_KEY_RE", () => {
  it("admite imagenes y videos con nombre aleatorio, y nada mas", () => {
    const hex = "a".repeat(48);
    for (const ext of ["jpg", "png", "mp4", "mov"]) expect(media.MEDIA_KEY_RE.test(`${hex}.${ext}`)).toBe(true);
    for (const bad of [`${hex}.part`, `${hex}.exe`, `${"a".repeat(47)}.mp4`, `../${hex}.mp4`, `${hex}.mp4/x`]) expect(media.MEDIA_KEY_RE.test(bad)).toBe(false);
  });
});

describe("receiveToTemp", () => {
  it("escribe lo recibido y exige los bytes declarados", async () => {
    const r = await media.receiveToTemp(streamOf(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])), 5);
    expect(r).toMatchObject({ ok: true, bytes: 5 });
    if (!r.ok) return;
    expect(r.temp).toMatch(/^[a-f0-9]{48}\.part$/);
    expect([...(await readFile(path.join(dir, r.temp)))]).toEqual([1, 2, 3, 4, 5]);
    await media.discardTemp(r.temp);
    expect(await names()).toEqual([]);
  });

  it("una subida cortada (menos bytes que content-length) se rechaza y no deja nada", async () => {
    const r = await media.receiveToTemp(streamOf(new Uint8Array(10)), 25);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/incompleta \(10 de 25 bytes\)/) });
    expect(await names()).toEqual([]);
  });

  it("mas bytes de los declarados tambien se rechaza", async () => {
    const r = await media.receiveToTemp(streamOf(new Uint8Array(10), new Uint8Array(10)), 15);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/más bytes/) });
    expect(await names()).toEqual([]);
  });

  it("si la conexion se corta a la mitad no queda un archivo a medias", async () => {
    let n = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(c) {
        if (n++ === 0) c.enqueue(new Uint8Array(100));
        else c.error(new Error("conexion cortada"));
      },
    });
    const r = await media.receiveToTemp(broken, 500);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Se cortó la conexión/) });
    expect(await names()).toEqual([]);
  });

  it("recibe un archivo mas grande que los 10 MB que el proxy de Next dejaria pasar cortados", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(7);
    const total = 25;
    const r = await media.receiveToTemp(streamOf(...Array.from({ length: total }, () => chunk)), total * chunk.length);
    expect(r).toMatchObject({ ok: true, bytes: 25 * 1024 * 1024 });
    if (r.ok) {
      expect((await stat(path.join(dir, r.temp))).size).toBe(25 * 1024 * 1024);
      await media.discardTemp(r.temp);
    }
  });
});

describe("video en disco: leer, reordenar, dar nombre definitivo y servir por tramos", () => {
  it("lee un provisional, lo reordena a fast start, lo confirma y sirve un tramo", async () => {
    const original = buildMp4({ moovFirst: false, mdatBytes: 50_000 });
    const received = await media.receiveToTemp(streamOf(original), original.length);
    if (!received.ok) throw new Error(received.error);

    const read = await media.withFileSource(received.temp, (src) => readVideoInfo(src));
    if (!read.ok) throw new Error(read.error);
    expect(read.info.fastStart).toBe(false);

    const boxes = read.boxes;
    const plan = await media.withFileSource(received.temp, (src) => faststartLayout(src, boxes));
    if (!plan.ok || !plan.changed) throw new Error("se esperaba un plan");
    const fixed = media.newTempName();
    await media.writeFaststart(received.temp, fixed, plan.layout);
    const again = await media.withFileSource(fixed, (src) => readVideoInfo(src));
    expect(again.ok && again.info.fastStart).toBe(true);
    expect((await stat(path.join(dir, fixed))).size).toBe(original.length);
    await media.discardTemp(received.temp);

    const key = await media.commitTemp(fixed, "mp4");
    expect(key).toMatch(/^[a-f0-9]{48}\.mp4$/);
    expect(await names()).toEqual([key]);
    expect(await media.statMedia(key)).toEqual({ size: original.length });

    const chunk = await readAll(media.readMediaRange(key, 10, 29)!);
    const whole = await readFile(path.join(dir, key));
    expect([...chunk]).toEqual([...whole.subarray(10, 30)]);
    await media.deleteImage(key);
    expect(await media.statMedia(key)).toBeNull();
  });

  it("no abre nombres que no son de la carpeta de medios", async () => {
    await expect(media.withFileSource("../fuera.mp4", async () => 1)).rejects.toThrow();
    expect(await media.statMedia("../../etc/passwd")).toBeNull();
    expect(media.readMediaRange("no-valido.mp4", 0, 1)).toBeNull();
  });
});

describe("cleanStaleParts", () => {
  it("borra los provisionales de hace mas de una hora y deja lo demas", async () => {
    const old = `${"b".repeat(48)}.part`;
    const fresh = `${"c".repeat(48)}.part`;
    const keep = `${"d".repeat(48)}.jpg`;
    for (const n of [old, fresh, keep]) await writeFile(path.join(dir, n), "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(path.join(dir, old), twoHoursAgo, twoHoursAgo);
    await media.cleanStaleParts();
    expect(await names()).toEqual([fresh, keep].sort());
  });
});
