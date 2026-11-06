// Videos: lectura por contenido de MP4/MOV y reglas de Meta para Reels e historias.
// Sin dependencias ni ffmpeg: recorre las "cajas" (atoms) del contenedor ISO-BMFF y lee solo lo necesario.
// Pura (sirve en el servidor y en el navegador). Recibe un lector `read(offset, length)` en lugar del archivo entero
// para no cargar en memoria decenas de MB: en el servidor lee del disco; en las pruebas, de un arreglo de bytes.

/** Tamano maximo de un video subido a la app (Meta admite hasta 300 MB en Reels y 100 MB en historias de Instagram). */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
/** Una publicacion con video lleva un solo video (sin carrusel; un Reel no entra en un carrusel de Instagram). */
export const MAX_VIDEOS_PER_POST = 1;
/** Duracion minima que aceptan Instagram y Facebook. */
export const MIN_VIDEO_SECONDS = 3;

const MAX_TOP_BOXES = 2000;
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

export type VideoSource = { size: number; read: (offset: number, length: number) => Promise<Uint8Array> };

/** Lector sobre bytes en memoria (pruebas y archivos pequenos). */
export function bytesSource(bytes: Uint8Array): VideoSource {
  return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)) };
}

/** Lo que se lee del archivo y no tiene columna propia (se guarda como JSON en PostMedia.videoInfo). */
export type VideoDetails = {
  container: "mp4" | "mov";
  /** Marca principal del contenedor (isom, mp42, qt...). */
  brand: string;
  /** Tipo de muestra del video (avc1/avc3 = H.264, hvc1/hev1 = HEVC). */
  videoCodec: string;
  /** Fotogramas por segundo (media); null si no se pudo calcular. */
  fps: number | null;
  /** Giro con el que se muestra (los videos de telefono suelen venir girados 90 grados). */
  rotation: 0 | 90 | 180 | 270;
  /** Bits por segundo, media de todo el archivo. */
  bitrate: number;
  /** El indice (moov) esta antes de los datos (mdat): Meta lo exige asi. */
  fastStart: boolean;
  /** Pista de audio, o null si el video no tiene sonido (Meta lo acepta). */
  audio: { codec: string; channels: number | null; sampleRate: number | null } | null;
};

export type VideoInfo = VideoDetails & {
  mimeType: "video/mp4" | "video/quicktime";
  extension: "mp4" | "mov";
  /** Tamano como se ve (con el giro ya aplicado). */
  width: number;
  height: number;
  durationMs: number;
  size: number;
};

/** Recupera lo guardado en la base de datos; null si no tiene la forma esperada (filas antiguas o a mano). */
export function parseVideoDetails(value: unknown): VideoDetails | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.videoCodec !== "string" || typeof v.bitrate !== "number" || typeof v.fastStart !== "boolean") return null;
  const audio = v.audio && typeof v.audio === "object" ? (v.audio as Record<string, unknown>) : null;
  const rotation = v.rotation === 90 || v.rotation === 180 || v.rotation === 270 ? v.rotation : 0;
  return {
    container: v.container === "mov" ? "mov" : "mp4",
    brand: typeof v.brand === "string" ? v.brand : "",
    videoCodec: v.videoCodec,
    fps: typeof v.fps === "number" ? v.fps : null,
    rotation,
    bitrate: v.bitrate,
    fastStart: v.fastStart,
    audio: audio
      ? {
          codec: typeof audio.codec === "string" ? audio.codec : "",
          channels: typeof audio.channels === "number" ? audio.channels : null,
          sampleRate: typeof audio.sampleRate === "number" ? audio.sampleRate : null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Cajas ISO-BMFF
// ---------------------------------------------------------------------------

export type TopBox = { type: string; start: number; size: number; headerSize: number };

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const viewOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Cajas de primer nivel. `truncated`: la ultima declara mas bytes de los que tiene el archivo (subida cortada). null = no es un contenedor valido. */
export async function scanTopLevel(src: VideoSource): Promise<{ boxes: TopBox[]; truncated: boolean } | null> {
  const boxes: TopBox[] = [];
  let offset = 0;
  while (offset < src.size) {
    if (boxes.length >= MAX_TOP_BOXES) return null;
    const remaining = src.size - offset;
    if (remaining < 8) break; // sobras sin importancia (relleno)
    const head = await src.read(offset, Math.min(16, remaining));
    if (head.length < 8) return null;
    const view = viewOf(head);
    let size = view.getUint32(0);
    const type = ascii(head, 4);
    let headerSize = 8;
    if (size === 0 && type === "\0\0\0\0") break; // relleno de ceros al final del archivo
    if (size === 1) {
      if (head.length < 16) return null;
      size = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
      headerSize = 16;
    } else if (size === 0) {
      size = remaining; // "hasta el final del archivo"
    }
    if (size < headerSize || !/^[\x20-\x7e\xa9]{4}$/.test(type)) return null;
    if (size > remaining) {
      boxes.push({ type, start: offset, size, headerSize });
      return { boxes, truncated: true };
    }
    boxes.push({ type, start: offset, size, headerSize });
    offset += size;
  }
  return { boxes, truncated: false };
}

type Child = { type: string; start: number; dataStart: number; end: number };

/** Cajas hijas entre `start` y `end` de un bloque en memoria. Se detiene ante una caja que no cabe. */
function listChildren(buf: Uint8Array, start: number, end: number): Child[] {
  const view = viewOf(buf);
  const out: Child[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = ascii(buf, pos + 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = view.getUint32(pos + 8) * 2 ** 32 + view.getUint32(pos + 12);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    out.push({ type, start: pos, dataStart: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}

const childOf = (buf: Uint8Array, parent: { dataStart: number; end: number }, type: string) =>
  listChildren(buf, parent.dataStart, parent.end).find((c) => c.type === type);

/** Escala de tiempo y duracion de `mvhd` y `mdhd` (misma disposicion). */
function timesOf(buf: Uint8Array, box: Child): { timescale: number; duration: number } | null {
  const view = viewOf(buf);
  const ds = box.dataStart;
  if (buf[ds] === 1) {
    if (ds + 32 > box.end) return null;
    return { timescale: view.getUint32(ds + 20), duration: view.getUint32(ds + 24) * 2 ** 32 + view.getUint32(ds + 28) };
  }
  if (ds + 20 > box.end) return null;
  return { timescale: view.getUint32(ds + 12), duration: view.getUint32(ds + 16) };
}

const rotationOf = (a: number, b: number): 0 | 90 | 180 | 270 => {
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
};

type TrackInfo = {
  handler: string;
  sampleType: string;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  durationSeconds: number | null;
  samples: number | null;
  channels: number | null;
  sampleRate: number | null;
};

function parseTrack(buf: Uint8Array, trak: Child): TrackInfo | null {
  const view = viewOf(buf);
  const mdia = childOf(buf, trak, "mdia");
  if (!mdia) return null;
  const hdlr = childOf(buf, mdia, "hdlr");
  if (!hdlr || hdlr.dataStart + 12 > hdlr.end) return null;
  const info: TrackInfo = {
    handler: ascii(buf, hdlr.dataStart + 8),
    sampleType: "",
    width: 0,
    height: 0,
    rotation: 0,
    durationSeconds: null,
    samples: null,
    channels: null,
    sampleRate: null,
  };

  const tkhd = childOf(buf, trak, "tkhd");
  if (tkhd) {
    const v1 = buf[tkhd.dataStart] === 1;
    const matrix = tkhd.dataStart + (v1 ? 52 : 40);
    const size = tkhd.dataStart + (v1 ? 88 : 76);
    if (size + 8 <= tkhd.end) {
      info.width = Math.round(view.getUint32(size) / 65536);
      info.height = Math.round(view.getUint32(size + 4) / 65536);
      info.rotation = rotationOf(view.getInt32(matrix), view.getInt32(matrix + 4));
    }
  }

  const mdhd = childOf(buf, mdia, "mdhd");
  const times = mdhd ? timesOf(buf, mdhd) : null;
  if (times && times.timescale > 0 && times.duration > 0) info.durationSeconds = times.duration / times.timescale;

  const minf = childOf(buf, mdia, "minf");
  const stbl = minf ? childOf(buf, minf, "stbl") : undefined;
  if (stbl) {
    const stsd = childOf(buf, stbl, "stsd");
    if (stsd && stsd.dataStart + 16 <= stsd.end) {
      info.sampleType = ascii(buf, stsd.dataStart + 12);
      if (info.handler === "vide" && (info.width === 0 || info.height === 0) && stsd.dataStart + 44 <= stsd.end) {
        info.width = view.getUint16(stsd.dataStart + 40);
        info.height = view.getUint16(stsd.dataStart + 42);
      }
      if (info.handler === "soun" && stsd.dataStart + 44 <= stsd.end) {
        info.channels = view.getUint16(stsd.dataStart + 32) || null;
        info.sampleRate = view.getUint32(stsd.dataStart + 40) >>> 16 || null;
      }
    }
    const stts = childOf(buf, stbl, "stts");
    if (stts && stts.dataStart + 8 <= stts.end) {
      const n = Math.min(view.getUint32(stts.dataStart + 4), Math.floor((stts.end - stts.dataStart - 8) / 8));
      let total = 0;
      for (let i = 0; i < n; i++) total += view.getUint32(stts.dataStart + 8 + i * 8);
      info.samples = total;
    }
  }
  return info;
}

// ---------------------------------------------------------------------------
// Lectura de un video
// ---------------------------------------------------------------------------

const VIDEO_CODEC_NAMES: Record<string, string> = { avc1: "H.264", avc3: "H.264", hvc1: "HEVC (H.265)", hev1: "HEVC (H.265)" };
/** Nombre legible del codec de video (o el codigo tal cual si no es uno de los admitidos). */
export const videoCodecName = (code: string) => VIDEO_CODEC_NAMES[code] ?? `«${code.trim()}»`;

const AUDIO_CODEC_NAMES: Record<string, string> = { mp4a: "AAC", "ac-3": "AC-3", "ec-3": "E-AC-3", opus: "Opus", alac: "ALAC", ".mp3": "MP3", sowt: "PCM", twos: "PCM", lpcm: "PCM", ipcm: "PCM" };
export const audioCodecName = (code: string) => AUDIO_CODEC_NAMES[code] ?? `«${code.trim()}»`;

const fmt1 = (n: number) => n.toFixed(1).replace(".", ",").replace(/,0$/, "");

/**
 * Reconoce un video MP4 o MOV por su contenido y devuelve lo que importa a Meta, o un motivo de rechazo en español.
 * Solo rechaza lo que ninguna red acepta (archivo cortado o ilegible, sin video, codec no admitido, indice al final
 * sin poder arreglarse...); los limites propios de cada destino se revisan despues con `videoProblems`.
 */
export async function readVideoInfo(src: VideoSource): Promise<{ ok: true; info: VideoInfo; boxes: TopBox[] } | { ok: false; error: string }> {
  if (src.size === 0) return { ok: false, error: "El archivo está vacío." };
  if (src.size > MAX_VIDEO_BYTES) {
    return { ok: false, error: `El video pesa ${(src.size / 1024 / 1024).toFixed(0)} MB y el máximo es ${MAX_VIDEO_BYTES / 1024 / 1024} MB.` };
  }
  const notVideo = { ok: false as const, error: "El archivo no es un video MP4 o MOV (no se reconoce su contenido)." };

  const scan = await scanTopLevel(src);
  if (!scan || scan.boxes.length === 0 || scan.boxes[0].type !== "ftyp") return notVideo;
  if (scan.truncated) {
    return { ok: false, error: "El video está incompleto: la subida se cortó o el archivo está dañado. Vuelve a subirlo." };
  }
  const { boxes } = scan;

  const ftypBox = boxes[0];
  const ftyp = await src.read(ftypBox.start + ftypBox.headerSize, Math.min(ftypBox.size - ftypBox.headerSize, 64));
  if (ftyp.length < 4) return notVideo;
  const brand = ascii(ftyp, 0);

  const moovBox = boxes.find((b) => b.type === "moov");
  const mdatBoxes = boxes.filter((b) => b.type === "mdat");
  if (!moovBox || mdatBoxes.length === 0 || mdatBoxes.every((b) => b.size <= b.headerSize)) {
    return {
      ok: false,
      error: "No se pudo leer el video: le falta el índice («moov») o los datos. El archivo está dañado o no terminó de grabarse.",
    };
  }
  if (moovBox.size > MAX_MOOV_BYTES) return { ok: false, error: "El índice del video es demasiado grande: el archivo no parece un video normal." };

  const moov = await src.read(moovBox.start + moovBox.headerSize, moovBox.size - moovBox.headerSize);
  if (moov.length < moovBox.size - moovBox.headerSize) return notVideo;
  const root = { dataStart: 0, end: moov.length };
  const kids = listChildren(moov, 0, moov.length);

  if (kids.some((c) => c.type === "mvex")) {
    return {
      ok: false,
      error: "El video está fragmentado (MP4 fragmentado, típico de grabadores de pantalla y de descargas). Expórtalo de nuevo como MP4 normal con H.264 y AAC.",
    };
  }

  const tracks = kids.filter((c) => c.type === "trak").map((t) => parseTrack(moov, t)).filter((t): t is TrackInfo => t !== null);
  const video = tracks.find((t) => t.handler === "vide");
  if (!video) return { ok: false, error: "El archivo no tiene pista de video." };
  if (!VIDEO_CODEC_NAMES[video.sampleType]) {
    return {
      ok: false,
      error: `El video usa el códec ${videoCodecName(video.sampleType)} y Instagram y Facebook solo aceptan H.264 o HEVC (H.265). Expórtalo de nuevo con uno de ellos.`,
    };
  }
  const audioTrack = tracks.find((t) => t.handler === "soun");

  const mvhd = childOf(moov, root, "mvhd");
  const movieTimes = mvhd ? timesOf(moov, mvhd) : null;
  let seconds = movieTimes && movieTimes.timescale > 0 && movieTimes.duration > 0 ? movieTimes.duration / movieTimes.timescale : null;
  if (seconds === null) seconds = video.durationSeconds;
  if (seconds === null || seconds <= 0) return { ok: false, error: "No se pudo leer la duración del video: el archivo parece dañado." };

  const rotated = video.rotation === 90 || video.rotation === 270;
  const width = rotated ? video.height : video.width;
  const height = rotated ? video.width : video.height;
  if (width < 1 || height < 1) return { ok: false, error: "No se pudo leer el tamaño del video: el archivo parece dañado." };
  if (width > 20_000 || height > 20_000) return { ok: false, error: "El video es demasiado grande (máximo 20.000 píxeles por lado)." };

  const fpsSeconds = video.durationSeconds ?? seconds;
  const fps = video.samples && video.samples > 0 && fpsSeconds > 0 ? video.samples / fpsSeconds : null;
  const mov = brand === "qt  ";

  return {
    ok: true,
    boxes,
    info: {
      mimeType: mov ? "video/quicktime" : "video/mp4",
      extension: mov ? "mov" : "mp4",
      container: mov ? "mov" : "mp4",
      brand,
      videoCodec: video.sampleType,
      fps: fps !== null ? Math.round(fps * 100) / 100 : null,
      rotation: video.rotation,
      bitrate: Math.round((src.size * 8) / seconds),
      fastStart: moovBox.start < Math.min(...mdatBoxes.map((b) => b.start)),
      audio: audioTrack ? { codec: audioTrack.sampleType, channels: audioTrack.channels, sampleRate: audioTrack.sampleRate } : null,
      width,
      height,
      durationMs: Math.round(seconds * 1000),
      size: src.size,
    },
  };
}

// ---------------------------------------------------------------------------
// Reglas de Meta por destino (documentacion leida el 2026-11-06; Meta las cambia)
// ---------------------------------------------------------------------------

export type VideoCheckInput = { width: number | null; height: number | null; durationMs: number | null; size: number; details: VideoDetails | null };

/** Largo maximo en segundos segun destino y formato. */
export const VIDEO_MAX_SECONDS = {
  INSTAGRAM_PROFILE: { FEED: 15 * 60, STORY: 60 },
  FACEBOOK_PAGE: { FEED: 90, STORY: 60 },
} as const;

/** Proporcion ideal de un video vertical. */
const VERTICAL_RATIO = 9 / 16;

const label = (s: number) => (s >= 120 && s % 60 === 0 ? `${s / 60} minutos` : s === 60 ? "1 minuto" : `${s} segundos`);
const seconds1 = (ms: number) => `${fmt1(ms / 1000)} s`;

/**
 * Problemas de un video para los destinos elegidos (errores que Meta rechazaria y avisos que no bloquean), en español.
 * Con varios destinos manda el mas estricto. Sin lo leido del archivo (filas antiguas) solo se revisa lo basico.
 */
export function videoProblems(v: VideoCheckInput, opts: { story: boolean; kinds: readonly string[] }): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ig = opts.kinds.includes("INSTAGRAM_PROFILE");
  const fb = opts.kinds.includes("FACEBOOK_PAGE");
  const d = v.details;
  const kind = opts.story ? "STORY" : "FEED";

  if (v.size > MAX_VIDEO_BYTES) errors.push(`El video pesa ${(v.size / 1024 / 1024).toFixed(0)} MB y el máximo es ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`);

  if (v.durationMs !== null) {
    const s = v.durationMs / 1000;
    if (s < MIN_VIDEO_SECONDS - 0.05) errors.push(`El video dura ${seconds1(v.durationMs)} y el mínimo es ${MIN_VIDEO_SECONDS} segundos.`);
    if (ig && s > VIDEO_MAX_SECONDS.INSTAGRAM_PROFILE[kind] + 0.1) {
      errors.push(`El video dura ${seconds1(v.durationMs)} y ${opts.story ? "las historias" : "los Reels"} de Instagram admiten hasta ${label(VIDEO_MAX_SECONDS.INSTAGRAM_PROFILE[kind])}.`);
    }
    if (fb && s > VIDEO_MAX_SECONDS.FACEBOOK_PAGE[kind] + 0.1) {
      errors.push(`El video dura ${seconds1(v.durationMs)} y ${opts.story ? "las historias" : "los Reels"} de Facebook admiten hasta ${label(VIDEO_MAX_SECONDS.FACEBOOK_PAGE[kind])}.`);
    }
  }

  const w = v.width ?? 0;
  const h = v.height ?? 0;
  if (w > 0 && h > 0) {
    if (ig && w > 1920) errors.push(`El video mide ${w} × ${h} píxeles y Instagram admite un ancho de hasta 1920. Reduce su resolución.`);
    if (fb) {
      if (Math.min(w, h) < 540 || Math.max(w, h) < 960) errors.push(`El video mide ${w} × ${h} píxeles y Facebook pide al menos 540 × 960 (lo ideal es 1080 × 1920).`);
      const ratio = w / h;
      if (ratio < VERTICAL_RATIO * 0.99 || ratio > (16 / 9) * 1.01) errors.push(`Facebook solo acepta videos entre las proporciones 9:16 (vertical) y 16:9 (horizontal) y este mide ${w} × ${h}.`);
    }
    if (Math.abs(w / h - VERTICAL_RATIO) / VERTICAL_RATIO > 0.1) {
      warnings.push(`Este video mide ${w} × ${h} píxeles. Los Reels y las historias se ven mejor en vertical 9:16 (por ejemplo 1080 × 1920); con otra proporción se verán con bandas o recortados.`);
    }
  }

  if (d) {
    if (!d.fastStart) {
      errors.push("El índice del video está al final del archivo y Meta lo exige al inicio. Expórtalo con la opción «optimizar para la web» (fast start).");
    }
    if (d.fps !== null) {
      if (ig && (d.fps < 22.9 || d.fps > 60.1)) errors.push(`Instagram admite entre 23 y 60 fotogramas por segundo y este video tiene ${fmt1(d.fps)}.`);
      if (fb && (d.fps < 23.9 || d.fps > 60.1)) errors.push(`Facebook admite entre 24 y 60 fotogramas por segundo y este video tiene ${fmt1(d.fps)}.`);
    }
    if (ig && d.bitrate > 25_000_000 * 1.05) {
      errors.push(`El video tiene unos ${fmt1(d.bitrate / 1_000_000)} Mbps y Instagram admite hasta 25 Mbps. Expórtalo con menos bitrate.`);
    }
    if (d.audio) {
      if (d.audio.codec !== "mp4a") errors.push(`El audio del video es ${audioCodecName(d.audio.codec)} y Meta solo acepta AAC. Expórtalo de nuevo con audio AAC.`);
      if (ig && d.audio.channels !== null && d.audio.channels > 2) errors.push(`El audio tiene ${d.audio.channels} canales e Instagram admite 1 o 2 (mono o estéreo).`);
      if (ig && d.audio.sampleRate !== null && d.audio.sampleRate > 48_000) errors.push(`El audio está a ${d.audio.sampleRate} Hz e Instagram admite hasta 48 kHz.`);
    }
    if (fb && d.container === "mov") warnings.push("Facebook recomienda MP4. Si rechaza este video (MOV), expórtalo como MP4 con H.264 y AAC.");
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Indice (moov) al inicio
// ---------------------------------------------------------------------------

export type FaststartLayout = {
  /** Lo que va primero en el archivo nuevo: la caja ftyp y el indice (moov) con las posiciones ya corregidas. */
  head: Uint8Array;
  /** El resto de cajas del archivo original, en su orden, como tramos a copiar. */
  ranges: { start: number; length: number }[];
};

/**
 * Muchos videos de telefono guardan el indice (moov) al final y Meta lo exige al inicio. Esto calcula como reescribir
 * el archivo: ftyp + moov (con las posiciones de `stco`/`co64` corridas por el tamano del moov) + las demas cajas.
 * No toca el archivo: devuelve el plan. Si el indice ya esta al inicio devuelve `changed: false`.
 */
export async function faststartLayout(
  src: VideoSource,
  boxes?: TopBox[],
): Promise<{ ok: true; changed: false } | { ok: true; changed: true; layout: FaststartLayout } | { ok: false; error: string }> {
  const fail = (error: string) => ({ ok: false as const, error });
  let list = boxes;
  if (!list) {
    const scan = await scanTopLevel(src);
    if (!scan || scan.truncated) return fail("El archivo no es un video MP4 o MOV válido.");
    list = scan.boxes;
  }
  const ftyp = list[0];
  const moov = list.find((b) => b.type === "moov");
  const firstMdat = list.find((b) => b.type === "mdat");
  if (!ftyp || ftyp.type !== "ftyp" || !moov || !firstMdat) return fail("El archivo no es un video MP4 o MOV válido.");
  if (moov.start < firstMdat.start) return { ok: true, changed: false };
  if (moov.size > MAX_MOOV_BYTES) return fail("El índice del video es demasiado grande para reordenarlo.");

  const insertAt = ftyp.start + ftyp.size;
  const shift = moov.size;
  const moovBytes = (await src.read(moov.start, moov.size)).slice(); // copia: se corrigen sus posiciones
  if (moovBytes.length < moov.size) return fail("No se pudo leer el índice del video.");
  const view = viewOf(moovBytes);

  const corrected = (offset: number): number | null => {
    if (offset >= moov.start + moov.size) return offset; // datos despues del indice original: no se mueven
    if (offset >= insertAt && offset < moov.start) return offset + shift;
    return null; // apunta dentro del propio indice o antes de ftyp: no es un archivo normal
  };

  const tables: Child[] = [];
  const walk = (parent: { dataStart: number; end: number }, path: string[]) => {
    for (const c of listChildren(moovBytes, parent.dataStart, parent.end)) {
      if (path.length === 4 && (c.type === "stco" || c.type === "co64")) tables.push(c);
      else if (path.length < 4 && c.type === ["trak", "mdia", "minf", "stbl"][path.length]) walk(c, [...path, c.type]);
    }
  };
  walk({ dataStart: moov.headerSize, end: moovBytes.length }, []);
  if (tables.length === 0) return fail("No se encontró la tabla de posiciones del video: no se puede reordenar.");

  for (const t of tables) {
    const n = view.getUint32(t.dataStart + 4);
    const wide = t.type === "co64";
    if (t.dataStart + 8 + n * (wide ? 8 : 4) > t.end) return fail("La tabla de posiciones del video está dañada.");
    for (let i = 0; i < n; i++) {
      const at = t.dataStart + 8 + i * (wide ? 8 : 4);
      const old = wide ? view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4) : view.getUint32(at);
      const next = corrected(old);
      if (next === null) return fail("El video guarda datos en un lugar que no se puede reordenar con seguridad.");
      if (wide) {
        view.setUint32(at, Math.floor(next / 2 ** 32));
        view.setUint32(at + 4, next >>> 0);
      } else {
        if (next > 0xffffffff) return fail("El video es demasiado grande para reordenarlo.");
        view.setUint32(at, next);
      }
    }
  }

  const ftypBytes = await src.read(ftyp.start, ftyp.size);
  const head = new Uint8Array(ftypBytes.length + moovBytes.length);
  head.set(ftypBytes, 0);
  head.set(moovBytes, ftypBytes.length);

  const ranges: { start: number; length: number }[] = [];
  for (const b of list) {
    if (b === ftyp || b === moov) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.start + last.length === b.start) last.length += b.size;
    else ranges.push({ start: b.start, length: b.size });
  }
  return { ok: true, changed: true, layout: { head, ranges } };
}
