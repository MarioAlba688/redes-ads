import * as z from "zod";

/** Zonas horarias que se ofrecen al crear una marca (la lista completa tiene cientos). */
export const COMMON_TIMEZONES = [
  "America/Bogota",
  "America/Mexico_City",
  "America/Lima",
  "America/Guayaquil",
  "America/Caracas",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "America/Sao_Paulo",
  "America/Panama",
  "America/New_York",
  "Europe/Madrid",
  "UTC",
] as const;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("es", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Los navegadores mandan los saltos de linea de un cuadro de texto como \r\n: se guardan siempre como \n. */
const normalizeNewlines = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n") : "");

/** Texto opcional: vacio -> null, y con tope de largo. */
const optionalText = (max: number, label: string) =>
  z.preprocess(
    normalizeNewlines,
    z
      .string()
      .trim()
      .max(max, { error: `${label} es demasiado largo (máximo ${max} caracteres).` })
      .transform((v) => (v === "" ? null : v)),
  );

export const brandSchema = z.object({
  name: z.preprocess(
    (v) => (typeof v === "string" ? v : ""),
    z.string().trim().min(2, { error: "Escribe el nombre de la marca." }).max(120, { error: "El nombre es demasiado largo." }),
  ),
  description: z.preprocess(
    normalizeNewlines,
    z
      .string()
      .trim()
      .min(20, { error: "Cuéntale a la IA qué hace el negocio, con al menos 20 caracteres." })
      .max(2000, { error: "La descripción es demasiado larga (máximo 2000 caracteres)." }),
  ),
  audience: optionalText(1000, "El público"),
  tone: optionalText(600, "El tono"),
  products: optionalText(2000, "La lista de productos"),
  avoid: optionalText(1000, "La lista de palabras a evitar"),
  hashtags: optionalText(300, "La lista de hashtags"),
  callToAction: optionalText(300, "El llamado a la acción"),
  language: z.enum(["es", "en", "pt"], { error: "Elige un idioma." }),
  timezone: z.string().refine(isValidTimeZone, { error: "Zona horaria no válida." }),
});

export type BrandInput = z.infer<typeof brandSchema>;
