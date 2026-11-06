import * as z from "zod";
import { maxCharsFor } from "@/lib/ai/limits";
import { POST_FORMATS, STORY_NOTE_MAX } from "@/lib/posts";

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

/** Largo del texto como lo cuentan las redes: una letra con emoji o acento cuenta una vez. */
export const textLength = (s: string) => Array.from(s).length;

export const postSchema = z
  .object({
    brandId: z.string().min(1, { error: "Elige una marca." }),
    // Cualquier cosa que no sea "STORY" es una publicacion normal.
    format: z.preprocess((v) => (v === "STORY" ? "STORY" : "FEED"), z.enum(POST_FORMATS)),
    // El texto se exige mas abajo, y solo en una publicacion normal: una historia sale sin texto.
    text: z.preprocess(normalizeNewlines, z.string().trim().max(63_000, { error: "El texto es demasiado largo." })),
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
  })
  .refine((v) => v.format === "STORY" || v.text !== "", { error: "Escribe el texto de la publicación.", path: ["text"] })
  .refine((v) => v.format !== "STORY" || textLength(v.text) <= STORY_NOTE_MAX, {
    error: `La nota de una historia admite hasta ${STORY_NOTE_MAX} caracteres (no se publica, es solo para reconocerla).`,
    path: ["text"],
  });

export type PostInput = z.infer<typeof postSchema>;

/** Error si el texto supera el limite de los destinos elegidos (el mas estricto manda), o null. */
export function lengthError(text: string, kinds: readonly string[]): string | null {
  const max = maxCharsFor(kinds);
  const len = textLength(text);
  return len > max ? `El texto tiene ${len} caracteres y el límite es ${max}${kinds.includes("INSTAGRAM_PROFILE") ? " (Instagram)" : ""}.` : null;
}
