import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";
import type { ImageInfo } from "@/lib/media-format";

/** Nombre de archivo valido: 24 bytes aleatorios en hexadecimal + extension. No se puede adivinar ni escapar de la carpeta. */
export const MEDIA_KEY_RE = /^[a-f0-9]{48}\.(jpg|png)$/;

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
  await mkdir(dir, { recursive: true });
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

/** Borra el archivo; si ya no esta no es un error. */
export async function deleteImage(key: string): Promise<void> {
  const full = pathFor(key);
  if (!full) return;
  try {
    await unlink(full);
  } catch {
    // ya no existia
  }
}

/** URL por la que se sirve una imagen (la usa la pantalla y tambien Meta para descargarla). */
export const mediaPath = (key: string) => `/media/${key}`;
