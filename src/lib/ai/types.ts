import * as z from "zod";

/** Lo que la IA necesita saber de una marca (lo que hay en el perfil). */
export type BrandProfile = {
  name: string;
  description: string;
  audience?: string | null;
  tone?: string | null;
  language: string;
  products?: string | null;
  avoid?: string | null;
  hashtags?: string | null;
  callToAction?: string | null;
};

/** Forma que se le exige a Claude (se valida con zod aunque la API ya garantice el JSON). */
export const aiOutputSchema = z.object({
  posts: z
    .array(
      z.object({
        angle: z.string(),
        text: z.string(),
        hashtags: z.array(z.string()),
        image_idea: z.string(),
      }),
    )
    .min(1),
});

/** El mismo esquema en JSON Schema, para `output_config.format` (salida estructurada de la API). */
export const AI_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          angle: { type: "string", description: "El enfoque de esta opcion, en pocas palabras." },
          text: { type: "string", description: "Texto de la publicacion, sin hashtags." },
          hashtags: { type: "array", items: { type: "string" }, description: "Hashtags sin el simbolo #." },
          image_idea: { type: "string", description: "Idea de la imagen o video que acompañaria al texto." },
        },
        required: ["angle", "text", "hashtags", "image_idea"],
        additionalProperties: false,
      },
    },
  },
  required: ["posts"],
  additionalProperties: false,
} as const;

/** Estado que devuelve la accion "Generar con IA" al editor. */
export type AiActionState =
  | {
      error?: string;
      posts?: GeneratedPost[];
      /** Opciones que se descartaron por usar palabras vetadas. */
      discarded?: number;
      usage?: { used: number; limit: number };
      /** Motor y modelo con los que se generaron las opciones. */
      engine?: { label: string; model: string };
      /** Lo que la persona escribio (React vacia el formulario tras cada envio). */
      values?: { brief: string; count: string; platform: string; provider: string };
    }
  | undefined;

export type GeneratedPost = {
  angle: string;
  /** Cuerpo, sin hashtags. */
  text: string;
  /** Hashtags ya limpios, con #. */
  hashtags: string[];
  imageIdea: string;
  /** Texto listo para publicar: cuerpo + hashtags. */
  fullText: string;
  length: number;
  warnings: string[];
};
