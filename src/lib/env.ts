import "server-only";
import { z } from "zod";
import { isValidTimeZone } from "@/lib/brands";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

/** URL que solo puede apuntar a esta misma maquina (variables de prueba: nunca desvian las claves a otro servidor). */
const loopbackUrl = (name: string) =>
  z
    .url()
    .refine((v) => ["localhost", "127.0.0.1"].includes(new URL(v).hostname), { error: `${name} solo puede apuntar a localhost (es para pruebas)` });

const schema = z.object({
  DATABASE_URL: z
    .string({ error: "Falta DATABASE_URL en el archivo .env" })
    .refine((v) => v.startsWith("mysql://"), {
      error: "DATABASE_URL debe empezar con mysql://",
    }),
  APP_URL: z.preprocess(emptyToUndefined, z.url().default("http://localhost:3000")),
  SETUP_TOKEN: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
  // Zona horaria con la que se muestran las fechas de la app (creacion, historial, sincronizaciones). Sin ella el
  // servidor usaria la suya (en un VPS suele ser UTC y las horas saldrian corridas). Las publicaciones programadas
  // siempre usan la zona de su marca.
  APP_TIMEZONE: z.preprocess(
    emptyToUndefined,
    z.string().refine(isValidTimeZone, { error: "APP_TIMEZONE no es una zona horaria valida (ej. America/Bogota)" }).default("America/Bogota"),
  ),

  // Carpeta donde se guardan las imagenes de las publicaciones. Debe ser persistente (en el VPS, fuera de la
  // carpeta del codigo) y se incluye en las copias de seguridad. Por defecto ./storage/media.
  MEDIA_DIR: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  // Direccion publica desde la que Meta descarga las imagenes para Instagram. Por defecto APP_URL, que debe
  // ser https y accesible desde internet. Solo se define para pruebas o si las imagenes salen por otro dominio.
  MEDIA_PUBLIC_BASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),

  // IA (Claude). Sin ANTHROPIC_API_KEY el generador de textos queda desactivado.
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().min(20, "ANTHROPIC_API_KEY parece incompleta").optional()),
  // Modelo de Claude. Por defecto el mas capaz de la linea Opus; uno mas barato (claude-sonnet-5-5, claude-haiku-5-5) tambien sirve para textos cortos.
  AI_MODEL: z.preprocess(emptyToUndefined, z.string().regex(/^claude-[a-z0-9.-]+$/, "AI_MODEL debe ser un id de modelo de Claude").default("claude-opus-5-5")),
  // Solo para pruebas: reemplazan api.openai.com y generativelanguage.googleapis.com por un servidor local.
  // (Las claves de OpenAI y Gemini no van en .env: las pone un administrador en la pantalla Motores de IA.)
  OPENAI_BASE_URL: z.preprocess(emptyToUndefined, loopbackUrl("OPENAI_BASE_URL").optional()),
  GEMINI_BASE_URL: z.preprocess(emptyToUndefined, loopbackUrl("GEMINI_BASE_URL").optional()),
  // Cuanto "piensa" el modelo antes de responder: low (mas barato y rapido) | medium | high.
  AI_EFFORT: z.preprocess(emptyToUndefined, z.enum(["low", "medium", "high"]).default("medium")),
  // Generaciones por persona en 24 horas (cada una cuesta unos centavos).
  AI_DAILY_LIMIT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(1000).default(40)),

  // Meta (Facebook, Instagram, Meta Ads). Opcionales: sin ellas la conexion queda desactivada.
  META_APP_ID: z.preprocess(emptyToUndefined, z.string().regex(/^\d+$/, "META_APP_ID debe ser numerico").optional()),
  META_APP_SECRET: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  // Permisos a pedir, separados por comas. Por defecto se piden todos (ver META_SCOPES en lib/meta/config.ts);
  // si tu app de Meta no incluye algunos (Facebook responde "Invalid Scopes"), lista solo los que si tiene.
  META_SCOPES: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\s*[a-z_]+(\s*,\s*[a-z_]+)*\s*$/, "META_SCOPES debe ser una lista separada por comas, ej. ads_read,pages_show_list")
      .optional(),
  ),
  // Solo si la app de Meta usa "Facebook Login for Business": ID de la configuracion creada en el panel
  // (con tipo de token "User access token"). Los permisos se eligen alli y no en la URL.
  META_LOGIN_CONFIG_ID: z.preprocess(
    emptyToUndefined,
    z.string().regex(/^\d+$/, "META_LOGIN_CONFIG_ID debe ser numerico").optional(),
  ),
  META_GRAPH_VERSION: z.preprocess(
    emptyToUndefined,
    z.string().regex(/^v\d+\.\d+$/, "META_GRAPH_VERSION debe ser como v26.0").default("v26.0"),
  ),
  // Google Ads. Se crean en Google Cloud Console (ver README, "Conectar Google Ads"). Sin ellos, el boton queda desactivado.
  GOOGLE_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().min(10, "GOOGLE_CLIENT_ID parece incompleto").optional()),
  GOOGLE_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().min(10, "GOOGLE_CLIENT_SECRET parece incompleto").optional()),
  // Version de la API de Google Ads (cada una dura ~1 año). Vigente al escribir esto: v25 (la v26 salio el 2026-10-14).
  GOOGLE_ADS_API_VERSION: z.preprocess(emptyToUndefined, z.string().regex(/^v\d+$/, "GOOGLE_ADS_API_VERSION debe ser como v25").default("v25")),
  // Opcional: desde el 2026-09-09 Google ignora el developer token (el acceso lo da el proyecto de Google Cloud).
  GOOGLE_ADS_DEVELOPER_TOKEN: z.preprocess(emptyToUndefined, z.string().min(10).optional()),
  // Solo para pruebas: reemplazan los servidores de Google por uno local.
  GOOGLE_OAUTH_BASE_URL: z.preprocess(emptyToUndefined, loopbackUrl("GOOGLE_OAUTH_BASE_URL").optional()),
  GOOGLE_ADS_API_BASE_URL: z.preprocess(emptyToUndefined, loopbackUrl("GOOGLE_ADS_API_BASE_URL").optional()),

  // TikTok Ads (Marketing API). Se crean en business-api.tiktok.com (ver README, "Conectar TikTok Ads").
  TIKTOK_APP_ID: z.preprocess(emptyToUndefined, z.string().regex(/^\d+$/, "TIKTOK_APP_ID debe ser numerico").optional()),
  TIKTOK_APP_SECRET: z.preprocess(emptyToUndefined, z.string().min(10, "TIKTOK_APP_SECRET parece incompleto").optional()),
  // Solo para pruebas: reemplaza business-api.tiktok.com por un servidor local.
  TIKTOK_API_BASE_URL: z.preprocess(emptyToUndefined, loopbackUrl("TIKTOK_API_BASE_URL").optional()),

  // Solo para pruebas: reemplaza facebook.com y graph.facebook.com por un servidor local.
  META_API_BASE_URL: z.preprocess(
    emptyToUndefined,
    z
      .url()
      .refine((v) => ["localhost", "127.0.0.1"].includes(new URL(v).hostname), {
        error: "META_API_BASE_URL solo puede apuntar a localhost (es para pruebas)",
      })
      .optional(),
  ),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Variables de entorno validadas. Se leen al primer uso, no al compilar. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((i) => `- ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Configuracion invalida (.env):\n${problems}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export const isProduction = () => process.env.NODE_ENV === "production";
