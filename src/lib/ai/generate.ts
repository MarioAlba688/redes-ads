import "server-only";
import type { AiProviderId } from "@/lib/ai/catalog";
import { engineFor } from "@/lib/ai/engines";
import { MSG_BAD_SHAPE, MSG_UNREADABLE } from "@/lib/ai/engines/messages";
import type { Engine } from "@/lib/ai/engines/types";
import { PLATFORM_LIMITS, type PostPlatform } from "@/lib/ai/limits";
import { buildSystemPrompt, buildUserPrompt } from "@/lib/ai/prompts";
import { assembleText, findForbidden, normalizeHashtags, parseAvoidList } from "@/lib/ai/text";
import { aiOutputSchema, type BrandProfile, type GeneratedPost } from "@/lib/ai/types";

/** Tope de tokens de salida. Los modelos que «piensan» gastan parte de el pensando, asi que se deja holgura. */
const MAX_TOKENS: Record<AiProviderId, number> = { anthropic: 8000, openai: 16000, gemini: 16000 };

/** Con que motor y modelo se hace la llamada (la clave ya viene descifrada). */
export type EngineConfig = { provider: AiProviderId; apiKey: string; model: string; effort: "low" | "medium" | "high" };

export type GenerateInput = {
  brand: BrandProfile;
  brief: string;
  count: number;
  platform: PostPlatform;
};

export type GenerateResult =
  | {
      ok: true;
      posts: GeneratedPost[];
      /** Opciones descartadas por usar palabras vetadas o venir vacias. */
      discarded: number;
      model: string;
      inputTokens: number;
      outputTokens: number;
    }
  | { ok: false; error: string; inputTokens?: number; outputTokens?: number };

type RawPost = { angle: string; text: string; hashtags: string[]; image_idea: string };

/** Limpia lo que devolvio la IA: hashtags, limites, palabras vetadas, repetidos. */
export function processPosts(
  raw: readonly RawPost[],
  opts: { brand: BrandProfile; platform: PostPlatform; count: number },
): { posts: GeneratedPost[]; discarded: number } {
  const limits = PLATFORM_LIMITS[opts.platform];
  const avoid = parseAvoidList(opts.brand.avoid);
  const seen = new Set<string>();
  const posts: GeneratedPost[] = [];
  let discarded = 0;

  for (const item of raw) {
    const body = item.text.trim();
    if (!body) {
      discarded++;
      continue;
    }
    const hashtags = normalizeHashtags(item.hashtags, limits.maxHashtags);
    const fullText = assembleText(body, hashtags);

    // Una opcion que usa una palabra vetada no se ofrece: es mejor mostrar menos que pasar algo que la marca prohibio.
    if (findForbidden(fullText, avoid).length > 0 || seen.has(fullText)) {
      discarded++;
      continue;
    }
    seen.add(fullText);

    const length = Array.from(fullText).length;
    const warnings: string[] = [];
    if (length > limits.maxChars) {
      warnings.push(`Tiene ${length} caracteres y el límite es ${limits.maxChars}: hay que acortarlo.`);
    }
    if (opts.platform !== "facebook" && /https?:\/\//i.test(fullText)) {
      warnings.push("Incluye un enlace; en Instagram no se puede pulsar.");
    }
    posts.push({ angle: item.angle.trim(), text: body, hashtags, imageIdea: item.image_idea.trim(), fullText, length, warnings });
  }

  return { posts: posts.slice(0, opts.count), discarded };
}

/**
 * Pide al motor elegido (Claude, GPT o Gemini) varias opciones de publicacion para una marca. Nunca lanza: devuelve
 * ok/error con un mensaje en español. No toca la base de datos (el limite diario y el registro estan en service.ts).
 * Lo que devuelve cada motor se valida igual: las reglas de la marca no dependen de la confianza en el modelo.
 */
export async function generatePosts(input: GenerateInput, deps: { config: EngineConfig; engine?: Engine }): Promise<GenerateResult> {
  const { config } = deps;
  const engine = deps.engine ?? engineFor(config.provider);

  const run = await engine.run({
    apiKey: config.apiKey,
    model: config.model,
    system: buildSystemPrompt(input.brand, input.platform),
    user: buildUserPrompt({ brief: input.brief, count: input.count }),
    maxTokens: MAX_TOKENS[config.provider],
    effort: config.effort,
  });
  if (!run.ok) return run;

  const { inputTokens, outputTokens } = run;
  const fail = (error: string): GenerateResult => ({ ok: false, error, inputTokens, outputTokens });

  let json: unknown;
  try {
    json = JSON.parse(run.text);
  } catch {
    return fail(MSG_UNREADABLE);
  }
  const parsed = aiOutputSchema.safeParse(json);
  if (!parsed.success) return fail(MSG_BAD_SHAPE);

  const { posts, discarded } = processPosts(parsed.data.posts, { brand: input.brand, platform: input.platform, count: input.count });
  if (posts.length === 0) {
    return fail(
      discarded > 0
        ? "Ninguna opción cumplió las reglas de la marca (usaban palabras que pediste evitar). Cambia la petición e inténtalo otra vez."
        : "La IA no devolvió ninguna opción. Inténtalo de nuevo.",
    );
  }
  return { ok: true, posts, discarded, model: run.model, inputTokens, outputTokens };
}
