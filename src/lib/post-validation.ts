import * as z from "zod";
import { maxCharsFor } from "@/lib/ai/limits";

/** Enlace opcional: solo http o https. */
const optionalUrl = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : ""),
  z
    .string()
    .max(500, { error: "El enlace es demasiado largo." })
    .refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v), { error: "El enlace debe empezar con http:// o https://." })
    .transform((v) => (v === "" ? null : v)),
);

/**
 * Los navegadores mandan los saltos de linea de un cuadro de texto como \r\n. Se guardan como \n: asi el
 * contador de caracteres del editor (que cuenta cada salto como 1) coincide con el limite del servidor.
 */
const normalizeNewlines = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n") : "");

export const postSchema = z.object({
  brandId: z.string().min(1, { error: "Elige una marca." }),
  text: z.preprocess(
    normalizeNewlines,
    z.string().trim().min(1, { error: "Escribe el texto de la publicación." }).max(63_000, { error: "El texto es demasiado largo." }),
  ),
  linkUrl: optionalUrl,
  aiGenerated: z.preprocess((v) => v === "true" || v === "on", z.boolean()),
  aiBrief: z.preprocess(
    normalizeNewlines,
    z
      .string()
      .trim()
      .max(2000)
      .transform((v) => (v === "" ? null : v)),
  ),
});

export type PostInput = z.infer<typeof postSchema>;

/** Largo del texto como lo cuentan las redes: una letra con emoji o acento cuenta una vez. */
export const textLength = (s: string) => Array.from(s).length;

/** Error si el texto supera el limite de los destinos elegidos (el mas estricto manda), o null. */
export function lengthError(text: string, kinds: readonly string[]): string | null {
  const max = maxCharsFor(kinds);
  const len = textLength(text);
  return len > max ? `El texto tiene ${len} caracteres y el límite es ${max}${kinds.includes("INSTAGRAM_PROFILE") ? " (Instagram)" : ""}.` : null;
}
