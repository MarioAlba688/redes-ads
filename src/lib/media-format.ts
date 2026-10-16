// Validacion de imagenes por su contenido (no por la extension ni por lo que diga el navegador).
// Sin dependencias: lee solo lo necesario de las cabeceras JPEG y PNG.

export type ImageKind = "image/jpeg" | "image/png";

export type ImageInfo = { mimeType: ImageKind; extension: "jpg" | "png"; width: number; height: number };

/** Tamano maximo de una imagen (limite de Instagram: 8 MB). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Imagenes por publicacion: lo que admite un carrusel de Instagram (Facebook admite al menos tantas). */
export const MAX_IMAGES_PER_POST = 10;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(b: Uint8Array) {
  return b.length >= 24 && PNG_SIGNATURE.every((v, i) => b[i] === v);
}

function isJpeg(b: Uint8Array) {
  return b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/** Ancho y alto de un PNG: estan en el bloque IHDR, justo tras la firma. */
function pngSize(b: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // 8 firma + 4 largo + 4 "IHDR" = 16
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Ancho y alto de un JPEG: se recorren los bloques hasta el primero de tipo "start of frame". */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i++;
      marker = b[i + 1];
    }
    // SOF0..SOF15 salvo DHT (C4), JPG (C8) y DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // fin de imagen / inicio de datos sin haber visto el tamano
    i += 2 + view.getUint16(i + 2);
  }
  return null;
}

/**
 * Reconoce una imagen JPEG o PNG por sus primeros bytes y devuelve su tamano, o un motivo de rechazo
 * en español. Un archivo que solo "se llama .jpg" no pasa.
 */
export function readImageInfo(bytes: Uint8Array): { ok: true; info: ImageInfo } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: "El archivo está vacío." };
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: `La imagen pesa ${(bytes.length / 1024 / 1024).toFixed(1)} MB y el máximo es 8 MB.` };
  }

  let mimeType: ImageKind;
  let size: { width: number; height: number } | null;
  if (isPng(bytes)) {
    mimeType = "image/png";
    size = pngSize(bytes);
  } else if (isJpeg(bytes)) {
    mimeType = "image/jpeg";
    size = jpegSize(bytes);
  } else {
    return { ok: false, error: "El archivo no es una imagen JPG o PNG." };
  }
  if (!size || size.width < 1 || size.height < 1) return { ok: false, error: "No se pudo leer el tamaño de la imagen: el archivo parece dañado." };
  if (size.width > 20_000 || size.height > 20_000) return { ok: false, error: "La imagen es demasiado grande (máximo 20.000 píxeles por lado)." };

  return { ok: true, info: { mimeType, extension: mimeType === "image/png" ? "png" : "jpg", ...size } };
}

// ---------------------------------------------------------------------------
// Reglas de Instagram para fotos de feed
// ---------------------------------------------------------------------------

export const INSTAGRAM_MIN_RATIO = 4 / 5; // vertical maximo
export const INSTAGRAM_MAX_RATIO = 1.91; // horizontal maximo
export const INSTAGRAM_MIN_WIDTH = 320;

/** Motivo por el que Instagram rechazaria la imagen, o null si sirve. */
export function instagramImageError(img: { mimeType: string; width: number; height: number }): string | null {
  if (img.mimeType !== "image/jpeg") return "Instagram solo acepta imágenes JPG. Convierte la imagen y vuelve a subirla.";
  if (img.width < INSTAGRAM_MIN_WIDTH) return `La imagen es muy pequeña para Instagram (mínimo ${INSTAGRAM_MIN_WIDTH} píxeles de ancho).`;
  const ratio = img.width / img.height;
  if (ratio < INSTAGRAM_MIN_RATIO - 0.005 || ratio > INSTAGRAM_MAX_RATIO + 0.005) {
    return "Instagram solo acepta fotos entre formato vertical 4:5 y horizontal 1,91:1. Recorta la imagen.";
  }
  return null;
}
