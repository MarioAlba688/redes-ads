import { describe, expect, it } from "vitest";
import {
  bytesSource,
  faststartLayout,
  MAX_VIDEO_BYTES,
  parseVideoDetails,
  readVideoInfo,
  videoProblems,
  type VideoCheckInput,
  type VideoDetails,
} from "@/lib/video-format";
import { buildMp4, sampleBytes } from "./helpers/mp4";

const read = async (opts: Parameters<typeof buildMp4>[0]) => {
  const r = await readVideoInfo(bytesSource(buildMp4(opts)));
  if (!r.ok) throw new Error(r.error);
  return r.info;
};
const reject = async (opts: Parameters<typeof buildMp4>[0]) => {
  const r = await readVideoInfo(bytesSource(buildMp4(opts)));
  return r.ok ? null : r.error;
};

describe("readVideoInfo", () => {
  it("lee tamano, duracion, fps, codecs y bitrate de un MP4 vertical", async () => {
    const info = await read({ width: 1080, height: 1920, durationMs: 12_000, fps: 30 });
    expect(info).toMatchObject({
      mimeType: "video/mp4",
      extension: "mp4",
      brand: "isom",
      width: 1080,
      height: 1920,
      durationMs: 12_000,
      fps: 30,
      videoCodec: "avc1",
      rotation: 0,
      fastStart: true,
      audio: { codec: "mp4a", channels: 2, sampleRate: 48000 },
    });
    expect(info.bitrate).toBeGreaterThan(0);
  });

  it("reconoce HEVC y un video sin audio", async () => {
    const info = await read({ videoCodec: "hvc1", audio: false });
    expect(info.videoCodec).toBe("hvc1");
    expect(info.audio).toBeNull();
  });

  it("aplica el giro: un video 1920x1080 girado 90 grados se ve vertical 1080x1920", async () => {
    for (const rotation of [90, 270] as const) {
      const info = await read({ width: 1920, height: 1080, rotation });
      expect([info.width, info.height, info.rotation]).toEqual([1080, 1920, rotation]);
    }
    const flipped = await read({ width: 1920, height: 1080, rotation: 180 });
    expect([flipped.width, flipped.height, flipped.rotation]).toEqual([1920, 1080, 180]);
  });

  it("lee las cabeceras de 64 bits (version 1)", async () => {
    const info = await read({ version1: true, durationMs: 7_000, width: 720, height: 1280 });
    expect([info.durationMs, info.width, info.height]).toEqual([7_000, 720, 1280]);
  });

  it("un MOV de QuickTime se acepta y se sirve como video/quicktime", async () => {
    const info = await read({ brand: "qt  " });
    expect([info.mimeType, info.extension, info.container]).toEqual(["video/quicktime", "mov", "mov"]);
  });

  it("detecta el indice al final (no es fast start)", async () => {
    expect((await read({ moovFirst: false })).fastStart).toBe(false);
    expect((await read({ moovFirst: true })).fastStart).toBe(true);
  });

  it("rechaza lo que no es un video, un archivo vacio y un video cortado", async () => {
    expect((await readVideoInfo(bytesSource(new Uint8Array(0)))).ok).toBe(false);
    expect(await readVideoInfo(bytesSource(new TextEncoder().encode("esto no es un video, solo texto de relleno")))).toMatchObject({ ok: false, error: expect.stringContaining("no es un video") });
    expect(await reject({ truncateBy: 100 })).toMatch(/incompleto/);
    expect(await reject({ moovFirst: false, truncateBy: 50 })).toMatch(/incompleto/);
  });

  it("rechaza un video sin indice, fragmentado, con un codec que Meta no acepta o mas grande que el tope", async () => {
    expect(await reject({ noMoov: true })).toMatch(/moov/);
    expect(await reject({ fragmented: true })).toMatch(/fragmentado/);
    expect(await reject({ videoCodec: "vp09" })).toMatch(/H\.264 o HEVC/);
    const huge = { size: MAX_VIDEO_BYTES + 1, read: async () => new Uint8Array(16) };
    expect(await readVideoInfo(huge)).toMatchObject({ ok: false, error: expect.stringContaining("el máximo es 100 MB") });
  });

  it("no depende de leer el archivo entero: lee cabeceras y el indice", async () => {
    const bytes = buildMp4({ mdatBytes: 200_000, moovFirst: false });
    let read = 0;
    const src = { size: bytes.length, read: async (o: number, l: number) => { const part = bytes.subarray(o, Math.min(bytes.length, o + l)); read += part.length; return part; } };
    expect((await readVideoInfo(src)).ok).toBe(true);
    expect(read).toBeLessThan(10_000);
  });
});

describe("parseVideoDetails", () => {
  it("recupera lo guardado y descarta lo que no tiene la forma esperada", async () => {
    const info = await read({ rotation: 90, width: 1920, height: 1080 });
    const { mimeType, extension, width, height, durationMs, size, ...details } = info;
    void mimeType; void extension; void width; void height; void durationMs; void size;
    expect(parseVideoDetails(JSON.parse(JSON.stringify(details)))).toEqual(details);
    expect(parseVideoDetails(null)).toBeNull();
    expect(parseVideoDetails({ videoCodec: "avc1" })).toBeNull();
  });
});

describe("faststartLayout", () => {
  const assemble = (file: Uint8Array, layout: { head: Uint8Array; ranges: { start: number; length: number }[] }) => {
    const parts = [layout.head, ...layout.ranges.map((r) => file.subarray(r.start, r.start + r.length))];
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  it("no toca un video que ya tiene el indice al inicio", async () => {
    expect(await faststartLayout(bytesSource(buildMp4({ moovFirst: true })))).toEqual({ ok: true, changed: false });
  });

  it("mueve el indice al inicio, conserva el tamano y las posiciones siguen apuntando a los mismos datos", async () => {
    const original = buildMp4({ moovFirst: false, mdatBytes: 5000, trailingFree: 40 });
    const src = bytesSource(original);
    const plan = await faststartLayout(src);
    expect(plan).toMatchObject({ ok: true, changed: true });
    if (!plan.ok || !plan.changed) return;
    const fixed = assemble(original, plan.layout);
    expect(fixed.length).toBe(original.length);

    const before = await readVideoInfo(src);
    const after = await readVideoInfo(bytesSource(fixed));
    expect(before.ok && before.info.fastStart).toBe(false);
    expect(after.ok && after.info.fastStart).toBe(true);
    expect(after.ok && after.info.width).toBe(1080);

    // El primer dato de mdat: en el original esta justo tras ftyp + cabecera de mdat; en el nuevo, tras ftyp + moov + cabecera.
    const ftypSize = new DataView(original.buffer, original.byteOffset).getUint32(0);
    const originalFirst = sampleBytes(original, ftypSize + 8);
    // Se busca el stco corregido en el archivo nuevo y se comprueba que apunta a los mismos bytes.
    const view = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
    let found = 0;
    for (let i = 0; i + 16 < fixed.length; i++) {
      if (fixed[i] === 0x73 && fixed[i + 1] === 0x74 && fixed[i + 2] === 0x63 && fixed[i + 3] === 0x6f) {
        const offset = view.getUint32(i + 4 + 8); // tras el tipo: version/flags (4) y cantidad (4)
        expect(sampleBytes(fixed, offset)).toEqual(originalFirst);
        found++;
      }
    }
    expect(found).toBe(2); // pista de video y de audio
  });

  it("rechaza un archivo sin tabla de posiciones o que apunta fuera de lo esperado", async () => {
    const plan = await faststartLayout(bytesSource(new TextEncoder().encode("no es un video en absoluto, de verdad")));
    expect(plan.ok).toBe(false);
  });
});

describe("videoProblems", () => {
  const details = (over: Partial<VideoDetails> = {}): VideoDetails => ({
    container: "mp4",
    brand: "isom",
    videoCodec: "avc1",
    fps: 30,
    rotation: 0,
    bitrate: 8_000_000,
    fastStart: true,
    audio: { codec: "mp4a", channels: 2, sampleRate: 48000 },
    ...over,
  });
  const video = (over: Partial<VideoCheckInput> = {}): VideoCheckInput => ({ width: 1080, height: 1920, durationMs: 30_000, size: 20 * 1024 * 1024, details: details(), ...over });
  const check = (v: VideoCheckInput, kinds: string[], story = false) => videoProblems(v, { story, kinds });

  it("un video vertical normal pasa en los dos destinos, de feed y de historia", () => {
    expect(check(video(), ["INSTAGRAM_PROFILE", "FACEBOOK_PAGE"])).toEqual({ errors: [], warnings: [] });
    expect(check(video({ durationMs: 45_000 }), ["INSTAGRAM_PROFILE", "FACEBOOK_PAGE"], true).errors).toEqual([]);
  });

  it("la duracion se mide contra el destino mas estricto", () => {
    expect(check(video({ durationMs: 100_000 }), ["INSTAGRAM_PROFILE"]).errors).toEqual([]);
    expect(check(video({ durationMs: 100_000 }), ["FACEBOOK_PAGE"]).errors.join(" ")).toMatch(/Facebook admiten hasta 90 segundos/);
    expect(check(video({ durationMs: 100_000 }), ["INSTAGRAM_PROFILE", "FACEBOOK_PAGE"]).errors).toHaveLength(1);
    expect(check(video({ durationMs: 61_000 }), ["INSTAGRAM_PROFILE"], true).errors.join(" ")).toMatch(/historias de Instagram admiten hasta 1 minuto/);
    expect(check(video({ durationMs: 16 * 60_000 }), ["INSTAGRAM_PROFILE"]).errors.join(" ")).toMatch(/15 minutos/);
    expect(check(video({ durationMs: 2_000 }), ["INSTAGRAM_PROFILE"]).errors.join(" ")).toMatch(/mínimo es 3 segundos/);
  });

  it("Instagram: ancho maximo 1920, fps 23-60, bitrate 25 Mbps y audio AAC de hasta 2 canales y 48 kHz", () => {
    expect(check(video({ width: 3840, height: 2160 }), ["INSTAGRAM_PROFILE"]).errors.join(" ")).toMatch(/ancho de hasta 1920/);
    expect(check(video({ width: 3840, height: 2160 }), ["FACEBOOK_PAGE"]).errors).toEqual([]);
    expect(check(video({ details: details({ fps: 15 }) }), ["INSTAGRAM_PROFILE"]).errors.join(" ")).toMatch(/entre 23 y 60/);
    expect(check(video({ details: details({ fps: 23.976 }) }), ["INSTAGRAM_PROFILE", "FACEBOOK_PAGE"]).errors).toEqual([]);
    expect(check(video({ details: details({ fps: 120 }) }), ["INSTAGRAM_PROFILE"]).errors).toHaveLength(1);
    expect(check(video({ details: details({ bitrate: 40_000_000 }) }), ["INSTAGRAM_PROFILE"]).errors.join(" ")).toMatch(/25 Mbps/);
    expect(check(video({ details: details({ bitrate: 40_000_000 }) }), ["FACEBOOK_PAGE"]).errors).toEqual([]);
    expect(check(video({ details: details({ audio: { codec: "ac-3", channels: 6, sampleRate: 48000 } }) }), ["FACEBOOK_PAGE"]).errors.join(" ")).toMatch(/solo acepta AAC/);
    expect(check(video({ details: details({ audio: { codec: "mp4a", channels: 6, sampleRate: 48000 } }) }), ["INSTAGRAM_PROFILE"]).errors.join(" ")).toMatch(/6 canales/);
    expect(check(video({ details: details({ audio: { codec: "mp4a", channels: 2, sampleRate: 64000 } }) }), ["INSTAGRAM_PROFILE"]).errors.join(" ")).toMatch(/48 kHz/);
    expect(check(video({ details: details({ audio: null }) }), ["INSTAGRAM_PROFILE", "FACEBOOK_PAGE"]).errors).toEqual([]);
  });

  it("Facebook: minimo 540x960 y proporcion entre 9:16 y 16:9", () => {
    expect(check(video({ width: 360, height: 640 }), ["FACEBOOK_PAGE"]).errors.join(" ")).toMatch(/al menos 540 × 960/);
    expect(check(video({ width: 360, height: 640 }), ["INSTAGRAM_PROFILE"]).errors).toEqual([]);
    expect(check(video({ width: 1920, height: 1080 }), ["FACEBOOK_PAGE"]).errors).toEqual([]);
    expect(check(video({ width: 1080, height: 2400 }), ["FACEBOOK_PAGE"]).errors.join(" ")).toMatch(/entre las proporciones 9:16/);
  });

  it("avisa (sin bloquear) si no es 9:16 y si es MOV para Facebook; bloquea el indice al final", () => {
    const wide = check(video({ width: 1920, height: 1080 }), ["INSTAGRAM_PROFILE"]);
    expect(wide.errors).toEqual([]);
    expect(wide.warnings.join(" ")).toMatch(/9:16/);
    expect(check(video({ details: details({ container: "mov" }) }), ["FACEBOOK_PAGE"]).warnings.join(" ")).toMatch(/MP4/);
    expect(check(video({ details: details({ container: "mov" }) }), ["INSTAGRAM_PROFILE"]).warnings).toEqual([]);
    expect(check(video({ details: details({ fastStart: false }) }), ["INSTAGRAM_PROFILE"]).errors.join(" ")).toMatch(/al final del archivo/);
  });

  it("sin lo leido del archivo (filas antiguas) revisa solo duracion, tamano y medidas", () => {
    expect(check(video({ details: null, durationMs: 100_000 }), ["FACEBOOK_PAGE"]).errors).toHaveLength(1);
    expect(check(video({ details: null }), ["INSTAGRAM_PROFILE"]).errors).toEqual([]);
    expect(check(video({ size: MAX_VIDEO_BYTES + 1 }), ["INSTAGRAM_PROFILE"]).errors.join(" ")).toMatch(/máximo es 100 MB/);
  });
});
