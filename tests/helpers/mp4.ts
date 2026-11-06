// Construye MP4 sinteticos en memoria para probar la lectura de videos (no se pueden reproducir: solo tienen la
// estructura de cajas que lee src/lib/video-format.ts, con muestras de relleno).

const enc = new TextEncoder();

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}
function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n);
  return b;
}
function i32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n);
  return b;
}
const zeros = (n: number) => new Uint8Array(n);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = cat(...parts);
  return cat(u32(8 + body.length), enc.encode(type), body);
}
const fullBox = (type: string, version: number, ...parts: Uint8Array[]) => box(type, new Uint8Array([version, 0, 0, 0]), ...parts);

export type Mp4Options = {
  brand?: string;
  width?: number;
  height?: number;
  /** Giro guardado en la matriz de `tkhd`. */
  rotation?: 0 | 90 | 180 | 270;
  durationMs?: number;
  fps?: number;
  /** Tipo de muestra del video (avc1, hvc1, vp09...). */
  videoCodec?: string;
  /** false = sin pista de audio. */
  audio?: { codec?: string; channels?: number; sampleRate?: number } | false;
  moovFirst?: boolean;
  /** Bytes de datos dentro de mdat. */
  mdatBytes?: number;
  fragmented?: boolean;
  /** Sin caja moov. */
  noMoov?: boolean;
  /** Quita los ultimos N bytes (subida cortada). */
  truncateBy?: number;
  /** Cajas extra al final (para probar datos despues del indice). */
  trailingFree?: number;
  /** tkhd y mvhd versiones 1 (64 bits). */
  version1?: boolean;
};

const MATRIX: Record<number, [number, number, number, number]> = {
  0: [0x10000, 0, 0, 0x10000],
  90: [0, 0x10000, -0x10000, 0],
  180: [-0x10000, 0, 0, -0x10000],
  270: [0, -0x10000, 0x10000, 0],
};

function matrix(rotation: 0 | 90 | 180 | 270): Uint8Array {
  const [a, b, c, d] = MATRIX[rotation];
  return cat(i32(a), i32(b), i32(0), i32(c), i32(d), i32(0), i32(0), i32(0), i32(0x40000000));
}

function track(o: Required<Pick<Mp4Options, "width" | "height" | "rotation" | "durationMs">>, kind: "vide" | "soun", sampleType: string, samples: number, offset: number, v1: boolean, audio?: { channels: number; sampleRate: number }): Uint8Array {
  const tkhd = v1
    ? fullBox("tkhd", 1, zeros(8), zeros(8), u32(1), zeros(4), u32(0), u32(o.durationMs), zeros(8), zeros(2), zeros(2), zeros(2), zeros(2), matrix(kind === "vide" ? o.rotation : 0), u32(kind === "vide" ? o.width * 65536 : 0), u32(kind === "vide" ? o.height * 65536 : 0))
    : fullBox("tkhd", 0, u32(0), u32(0), u32(1), zeros(4), u32(o.durationMs), zeros(8), zeros(2), zeros(2), zeros(2), zeros(2), matrix(kind === "vide" ? o.rotation : 0), u32(kind === "vide" ? o.width * 65536 : 0), u32(kind === "vide" ? o.height * 65536 : 0));
  const mdhd = fullBox("mdhd", 0, u32(0), u32(0), u32(1000), u32(o.durationMs), u16(0), u16(0));
  const hdlr = fullBox("hdlr", 0, zeros(4), enc.encode(kind), zeros(12), zeros(1));
  const entry =
    kind === "vide"
      ? box(sampleType, zeros(6), u16(1), zeros(16), u16(o.width), u16(o.height), u32(0x480000), u32(0x480000), zeros(4), u16(1), zeros(32), u16(0x18), u16(0xffff))
      : box(sampleType, zeros(6), u16(1), zeros(8), u16(audio?.channels ?? 2), u16(16), zeros(2), zeros(2), u32((audio?.sampleRate ?? 48000) * 65536));
  const stsd = fullBox("stsd", 0, u32(1), entry);
  const stts = fullBox("stts", 0, u32(1), u32(samples), u32(Math.max(1, Math.round(o.durationMs / Math.max(samples, 1)))));
  const stco = fullBox("stco", 0, u32(1), u32(offset));
  return box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", box("stbl", stsd, stts, stco))));
}

/** Arma un MP4 con la estructura pedida. `stco` apunta al principio de los datos de mdat. */
export function buildMp4(opts: Mp4Options = {}): Uint8Array {
  const width = opts.width ?? 1080;
  const height = opts.height ?? 1920;
  const durationMs = opts.durationMs ?? 10_000;
  const fps = opts.fps ?? 30;
  const rotation = opts.rotation ?? 0;
  const v1 = opts.version1 ?? false;
  const samples = Math.round((fps * durationMs) / 1000);
  const audio = opts.audio === false ? null : { codec: opts.audio?.codec ?? "mp4a", channels: opts.audio?.channels ?? 2, sampleRate: opts.audio?.sampleRate ?? 48000 };

  const ftyp = box("ftyp", enc.encode(opts.brand ?? "isom"), u32(512), enc.encode("isom"), enc.encode("mp42"));
  const data = new Uint8Array(opts.mdatBytes ?? 4096).map((_, i) => (i * 7 + 3) & 0xff);
  const mdat = box("mdat", data);
  const free = opts.trailingFree ? box("free", zeros(opts.trailingFree)) : new Uint8Array(0);

  const makeMoov = (dataOffset: number) =>
    box(
      "moov",
      fullBox("mvhd", v1 ? 1 : 0, ...(v1 ? [zeros(8), zeros(8), u32(1000), u32(0), u32(durationMs)] : [u32(0), u32(0), u32(1000), u32(durationMs)]), u32(0x10000), u16(0x100), zeros(10), matrix(0), zeros(24), u32(3)),
      track({ width, height, rotation, durationMs }, "vide", opts.videoCodec ?? "avc1", samples, dataOffset, v1),
      ...(audio ? [track({ width, height, rotation, durationMs }, "soun", audio.codec, Math.round(durationMs / 21), dataOffset, v1, audio)] : []),
      ...(opts.fragmented ? [box("mvex", fullBox("trex", 0, u32(1), u32(1), u32(0), u32(0), u32(0)))] : []),
    );

  const moovSize = opts.noMoov ? 0 : makeMoov(0).length;
  const moovFirst = opts.moovFirst ?? true;
  const dataStart = moovFirst ? ftyp.length + moovSize + 8 : ftyp.length + 8;
  const moov = opts.noMoov ? new Uint8Array(0) : makeMoov(dataStart);
  const whole = moovFirst ? cat(ftyp, moov, mdat, free) : cat(ftyp, mdat, moov, free);
  return opts.truncateBy ? whole.subarray(0, whole.length - opts.truncateBy) : whole;
}

/** Donde empiezan los datos de muestra de mdat en el archivo (para comprobar que las posiciones corregidas siguen apuntando a ellos). */
export function sampleBytes(file: Uint8Array, offset: number, length = 16): Uint8Array {
  return file.subarray(offset, offset + length);
}
