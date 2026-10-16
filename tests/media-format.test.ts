import { describe, expect, it } from "vitest";
import { instagramImageError, MAX_IMAGE_BYTES, readImageInfo } from "@/lib/media-format";

/** PNG minimo valido en cabeceras (firma + IHDR con el tamano indicado). */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13); // largo del bloque
  b.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

/** JPEG con un APP0 y un SOF0 que declara el tamano. */
function jpeg(width: number, height: number, withApp = true): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (withApp) parts.push(0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0)); // APP0 de 16 bytes
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, ...Array(9).fill(0));
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

describe("readImageInfo", () => {
  it("lee el tamano de un PNG", () => {
    const r = readImageInfo(png(1080, 1350));
    expect(r).toEqual({ ok: true, info: { mimeType: "image/png", extension: "png", width: 1080, height: 1350 } });
  });

  it("lee el tamano de un JPEG saltando los bloques anteriores", () => {
    expect(readImageInfo(jpeg(1080, 1080))).toEqual({ ok: true, info: { mimeType: "image/jpeg", extension: "jpg", width: 1080, height: 1080 } });
    expect(readImageInfo(jpeg(1920, 1005, false))).toMatchObject({ ok: true, info: { width: 1920, height: 1005 } });
  });

  it("rechaza lo que solo se llama .jpg: texto, HTML, ejecutables, PDF, GIF", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    for (const [name, bytes] of [
      ["texto", enc("hola, no soy una imagen")],
      ["html", enc("<html><script>alert(1)</script></html>")],
      ["exe", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])],
      ["pdf", enc("%PDF-1.7 ...")],
      ["gif", enc("GIF89a....................")],
      ["svg", enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ] as const) {
      const r = readImageInfo(bytes);
      expect(r.ok, name).toBe(false);
    }
    expect(readImageInfo(enc("hola"))).toEqual({ ok: false, error: "El archivo no es una imagen JPG o PNG." });
  });

  it("rechaza archivos vacios, demasiado pesados o dañados", () => {
    expect(readImageInfo(new Uint8Array(0))).toMatchObject({ ok: false, error: "El archivo está vacío." });
    const big = png(100, 100);
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
    huge.set(big);
    expect(readImageInfo(huge)).toMatchObject({ ok: false, error: expect.stringMatching(/máximo es 8 MB/) });
    expect(readImageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9, 0, 0]))).toMatchObject({ ok: false, error: expect.stringMatching(/dañado/) });
  });

  it("rechaza tamanos absurdos", () => {
    expect(readImageInfo(png(0, 100)).ok).toBe(false);
    expect(readImageInfo(png(30_000, 100))).toMatchObject({ ok: false, error: expect.stringMatching(/demasiado grande/) });
  });

  it("un JPEG truncado no hace que el lector se cuelgue ni lance", () => {
    expect(readImageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])).ok).toBe(false);
  });
});

describe("reglas de Instagram", () => {
  const ok = { mimeType: "image/jpeg", width: 1080, height: 1080 };

  it("acepta un JPG cuadrado, vertical 4:5 y horizontal 1,91:1", () => {
    expect(instagramImageError(ok)).toBeNull();
    expect(instagramImageError({ ...ok, width: 1080, height: 1350 })).toBeNull();
    expect(instagramImageError({ ...ok, width: 1910, height: 1000 })).toBeNull();
  });

  it("rechaza PNG, imagenes muy pequeñas y proporciones fuera de rango", () => {
    expect(instagramImageError({ ...ok, mimeType: "image/png" })).toMatch(/solo acepta imágenes JPG/);
    expect(instagramImageError({ ...ok, width: 200, height: 200 })).toMatch(/muy pequeña/);
    expect(instagramImageError({ ...ok, width: 1080, height: 1920 })).toMatch(/4:5/);
    expect(instagramImageError({ ...ok, width: 2400, height: 1000 })).toMatch(/1,91:1/);
  });
});
