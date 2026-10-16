import "server-only";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
