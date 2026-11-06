import "server-only";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { env } from "@/lib/env";
import type { ImageInfo } from "@/lib/media-format";
import type { FaststartLayout, VideoSource } from "@/lib/video-format";

/** Nombre de archivo valido: 24 bytes aleatorios en hexadecimal + extension. No se puede adivinar ni escapar de la carpeta. */
export const MEDIA_KEY_RE = /^[a-f0-9]{48}\.(jpg|png|mp4|mov)$/;
/** Archivo provisional de un video que se esta recibiendo: nunca se sirve (no cumple MEDIA_KEY_RE). */
const PART_RE = /^[a-f0-9]{48}\.part$/;

// Las imagenes viven en una carpeta que se decide al arrancar (MEDIA_DIR), no en el codigo:
// los comentarios turbopackIgnore evitan que el build intente empaquetar todo el proyecto por este acceso.
export function mediaDir(): string {
  return path.resolve(env().MEDIA_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "storage", "media"));
}

/** Ruta dentro de la carpeta de medios, o null si el nombre no es uno de los que generamos. */
function pathFor(key: string): string | null {
  if (!MEDIA_KEY_RE.test(key)) return null;
  const dir = mediaDir();
  const full = path.join(/*turbopackIgnore: true*/ dir, key);
  return full.startsWith(dir + path.sep) ? full : null;
}

/** Guarda la imagen con un nombre aleatorio y devuelve ese nombre. */
export async function saveImage(bytes: Uint8Array, info: Pick<ImageInfo, "extension">): Promise<string> {
  const dir = mediaDir();
  await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  const key = `${randomBytes(24).toString("hex")}.${info.extension}`;
  await writeFile(path.join(/*turbopackIgnore: true*/ dir, key), bytes, { flag: "wx" }); // wx: nunca pisa un archivo existente
  return key;
}

export async function readImage(key: string): Promise<Buffer | null> {
  const full = pathFor(key);
  if (!full) return null;
  try {
    return await readFile(/*turbopackIgnore: true*/ full);
  } catch {
    return null;
  }
}

/** ¿Esta el archivo en la carpeta de medios de ESTE servidor? */
export async function imageExists(key: string): Promise<boolean> {
  const full = pathFor(key);
  if (!full) return false;
  try {
    await access(/*turbopackIgnore: true*/ full);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lo que se le dice a la persona cuando la base de datos conoce una imagen pero su archivo no esta en este servidor.
 * La base de datos puede ser compartida, pero los archivos viven en el disco de cada servidor (MEDIA_DIR): si el
 * servidor se redespliega sin un volumen para esa carpeta, o la publicacion se creo en otra copia de la app (por
 * ejemplo en un PC apuntando a la misma base), el archivo no esta.
 */
export const MISSING_IMAGE_MESSAGE =
  "No se encontró el archivo de la imagen en este servidor. La base de datos la tiene registrada pero el archivo ya no está en la carpeta de imágenes (pasa si el servidor se redespliega sin un volumen para MEDIA_DIR, o si la publicación se creó en otra copia de la app). Vuelve a subir la imagen en Publicaciones y revisa que MEDIA_DIR esté en un volumen que sobreviva a los despliegues.";

/** Igual que MISSING_IMAGE_MESSAGE, para un video. */
export const MISSING_VIDEO_MESSAGE =
  "No se encontró el archivo del video en este servidor. La base de datos lo tiene registrado pero el archivo ya no está en la carpeta de medios (pasa si el servidor se redespliega sin un volumen para MEDIA_DIR, o si la publicación se creó en otra copia de la app). Vuelve a subir el video en un borrador nuevo y revisa que MEDIA_DIR esté en un volumen que sobreviva a los despliegues.";

/** Borra el archivo; si ya no esta no es un error. */
export async function deleteImage(key: string): Promise<void> {
  const full = pathFor(key);
  if (!full) return;
  try {
    await unlink(/*turbopackIgnore: true*/ full);
  } catch {
    // ya no existia
  }
}

/** URL por la que se sirve una imagen o un video (la usa la pantalla y tambien Meta para descargarlo). */
export const mediaPath = (key: string) => `/media/${key}`;

// ---------------------------------------------------------------------------
// Videos: se reciben, se leen y se sirven por partes (nunca enteros en memoria)
// ---------------------------------------------------------------------------

/** Ruta de un archivo de medios o provisional dentro de la carpeta, o null si el nombre no es de los que generamos. */
function fileFor(name: string): string | null {
  if (!MEDIA_KEY_RE.test(name) && !PART_RE.test(name)) return null;
  const dir = mediaDir();
  const full = path.join(/*turbopackIgnore: true*/ dir, name);
  return full.startsWith(dir + path.sep) ? full : null;
}

async function writeAll(fh: FileHandle, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await fh.write(bytes, written, bytes.length - written);
    if (bytesWritten === 0) throw new Error("No se pudo escribir en disco.");
    written += bytesWritten;
  }
}

export type ReceiveResult = { ok: true; temp: string; bytes: number } | { ok: false; error: string };

/**
 * Recibe el cuerpo de una subida grande escribiendolo a disco a medida que llega (sin guardarlo entero en memoria) en un
 * archivo provisional. Exige que lleguen EXACTAMENTE los bytes declarados en content-length: ni menos (una subida cortada
 * dejaria un video danado) ni mas. Si algo falla no deja nada en disco.
 */
export async function receiveToTemp(body: ReadableStream<Uint8Array>, expectedBytes: number): Promise<ReceiveResult> {
  const dir = mediaDir();
  await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  const temp = `${randomBytes(24).toString("hex")}.part`;
  const full = path.join(/*turbopackIgnore: true*/ dir, temp);
  const fh = await open(/*turbopackIgnore: true*/ full, "wx");
  const reader = body.getReader();
  let received = 0;
  let problem: string | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > expectedBytes) {
        problem = "Llegaron más bytes de los declarados. Vuelve a subir el video.";
        await reader.cancel().catch(() => undefined);
        break;
      }
      await writeAll(fh, value);
    }
  } catch {
    problem = "Se cortó la conexión mientras se subía el video. Vuelve a intentarlo.";
  }
  await fh.close().catch(() => undefined);
  if (!problem && received !== expectedBytes) {
    problem = `La subida llegó incompleta (${received} de ${expectedBytes} bytes). Vuelve a subir el video.`;
  }
  if (problem) {
    await unlink(/*turbopackIgnore: true*/ full).catch(() => undefined);
    return { ok: false, error: problem };
  }
  return { ok: true, temp, bytes: received };
}

/** Abre un archivo de medios (o provisional) como fuente de lectura por tramos, la use `fn` y se cierra siempre. */
export async function withFileSource<T>(name: string, fn: (src: VideoSource) => Promise<T>): Promise<T> {
  const full = fileFor(name);
  if (!full) throw new Error("Nombre de archivo no válido.");
  const fh = await open(/*turbopackIgnore: true*/ full, "r");
  try {
    const size = (await fh.stat()).size;
    return await fn({
      size,
      read: async (offset, length) => {
        const n = Math.max(0, Math.min(length, size - offset));
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, offset);
        return buf.subarray(0, bytesRead);
      },
    });
  } finally {
    await fh.close();
  }
}

/** Escribe `to` con el indice al inicio: la cabeza ya armada y luego los tramos de `from`, copiados por partes. */
export async function writeFaststart(from: string, to: string, layout: FaststartLayout): Promise<void> {
  const src = fileFor(from);
  const dst = fileFor(to);
  if (!src || !dst) throw new Error("Nombre de archivo no válido.");
  const out = await open(/*turbopackIgnore: true*/ dst, "wx");
  try {
    await writeAll(out, layout.head);
    const input = await open(/*turbopackIgnore: true*/ src, "r");
    try {
      const buf = Buffer.alloc(1024 * 1024);
      for (const range of layout.ranges) {
        let pos = range.start;
        let left = range.length;
        while (left > 0) {
          const { bytesRead } = await input.read(buf, 0, Math.min(left, buf.length), pos);
          if (bytesRead === 0) throw new Error("El archivo se acortó mientras se reordenaba.");
          await writeAll(out, buf.subarray(0, bytesRead));
          pos += bytesRead;
          left -= bytesRead;
        }
      }
    } finally {
      await input.close();
    }
  } finally {
    await out.close();
  }
}

/** Da su nombre definitivo (con extension) a un archivo provisional ya validado y devuelve ese nombre. */
export async function commitTemp(temp: string, extension: "mp4" | "mov"): Promise<string> {
  const from = fileFor(temp);
  if (!from || !PART_RE.test(temp)) throw new Error("Nombre de archivo no válido.");
  const key = temp.replace(/\.part$/, `.${extension}`);
  const to = fileFor(key);
  if (!to) throw new Error("Nombre de archivo no válido.");
  await rename(/*turbopackIgnore: true*/ from, /*turbopackIgnore: true*/ to);
  return key;
}

/** Borra un archivo provisional (si ya no esta no es un error). */
export async function discardTemp(temp: string): Promise<void> {
  const full = PART_RE.test(temp) ? fileFor(temp) : null;
  if (!full) return;
  await unlink(/*turbopackIgnore: true*/ full).catch(() => undefined);
}

/** Nombre para un archivo provisional nuevo (p. ej. el video reordenado). */
export const newTempName = () => `${randomBytes(24).toString("hex")}.part`;

/** Borra los provisionales que quedaron de subidas interrumpidas hace mas de una hora (el proceso se cayo a mitad). */
export async function cleanStaleParts(now = Date.now()): Promise<void> {
  try {
    const dir = mediaDir();
    for (const name of await readdir(/*turbopackIgnore: true*/ dir)) {
      if (!PART_RE.test(name)) continue;
      const full = path.join(/*turbopackIgnore: true*/ dir, name);
      const info = await stat(/*turbopackIgnore: true*/ full).catch(() => null);
      if (info && now - info.mtimeMs > 60 * 60_000) await unlink(/*turbopackIgnore: true*/ full).catch(() => undefined);
    }
  } catch {
    // La carpeta puede no existir todavia: no hay nada que limpiar.
  }
}

/** Tamano de un archivo de medios, o null si no esta en este servidor. */
export async function statMedia(key: string): Promise<{ size: number } | null> {
  const full = MEDIA_KEY_RE.test(key) ? pathFor(key) : null;
  if (!full) return null;
  try {
    const info = await stat(/*turbopackIgnore: true*/ full);
    return info.isFile() ? { size: info.size } : null;
  } catch {
    return null;
  }
}

/** Lee un tramo [start, end] (inclusive) de un archivo de medios como flujo web, sin cargarlo en memoria. */
export function readMediaRange(key: string, start: number, end: number): ReadableStream<Uint8Array> | null {
  const full = MEDIA_KEY_RE.test(key) ? pathFor(key) : null;
  if (!full) return null;
  return Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ full, { start, end })) as unknown as ReadableStream<Uint8Array>;
}
