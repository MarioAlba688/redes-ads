import "server-only";
import type { AiProviderId, EngineOption } from "@/lib/ai/catalog";
import { generatePosts, type GenerateInput, type GenerateResult } from "@/lib/ai/generate";
import { loadEngineStatuses, resolveRuntime } from "@/lib/ai/providers";
import { defaultEngineId, type EngineStatus } from "@/lib/ai/providers-core";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

const WINDOW_MS = 24 * 60 * 60 * 1000;

export type AiUsage = {
  /** Hay al menos un motor con clave y activo. */
  configured: boolean;
  used: number;
  limit: number;
  /** Motores entre los que se puede elegir. */
  engines: EngineOption[];
  /** El que se propone primero. */
  defaultEngine: AiProviderId | null;
};

const since = () => new Date(Date.now() - WINDOW_MS);
const optionsOf = (statuses: readonly EngineStatus[]): EngineOption[] => statuses.filter((s) => s.ready).map(({ id, label, model }) => ({ id, label, model }));

/** Cuantas generaciones lleva la persona en las ultimas 24 horas (con cualquier motor), su limite y los motores disponibles. */
export async function getAiUsage(userId: string): Promise<AiUsage> {
  const [statuses, used] = await Promise.all([loadEngineStatuses(), db.aiGeneration.count({ where: { userId, createdAt: { gte: since() } } })]);
  const engines = optionsOf(statuses);
  return { configured: engines.length > 0, used, limit: engines.length > 0 ? env().AI_DAILY_LIMIT : 0, engines, defaultEngine: defaultEngineId(statuses) };
}

/**
 * Genera opciones para una marca, con limite por persona y registro del consumo.
 * Cada llamada a la IA cuesta dinero: por eso hay un tope diario (compartido entre motores) y cada intento queda anotado.
 */
export async function generateForUser(
  args: GenerateInput & { userId: string; brandId: string; provider?: string | null },
): Promise<GenerateResult & { usage: AiUsage; engine?: { label: string; model: string } }> {
  const [resolved, used] = await Promise.all([resolveRuntime(args.provider), db.aiGeneration.count({ where: { userId: args.userId, createdAt: { gte: since() } } })]);
  const engines = optionsOf(resolved.statuses);
  const limit = engines.length > 0 ? env().AI_DAILY_LIMIT : 0;
  const usage: AiUsage = { configured: engines.length > 0, used, limit, engines, defaultEngine: defaultEngineId(resolved.statuses) };

  if (!resolved.ok) {
    const error =
      resolved.reason === "none"
        ? "La IA no está configurada: un administrador debe añadir una clave en Motores de IA."
        : resolved.reason === "unavailable"
          ? "El motor de IA que elegiste ya no está disponible. Elige otro."
          : "No se pudo leer la clave guardada de este motor (cambió ENCRYPTION_KEY). Un administrador debe volver a pegarla en Motores de IA.";
    return { ok: false, error, usage };
  }
  if (usage.used >= usage.limit) {
    return {
      ok: false,
      error: `Llegaste al límite de ${usage.limit} generaciones en 24 horas. Vuelve a intentarlo más tarde o pide a un administrador que suba AI_DAILY_LIMIT.`,
      usage,
    };
  }

  const { runtime } = resolved;
  const result = await generatePosts(
    { brand: args.brand, brief: args.brief, count: args.count, platform: args.platform },
    { config: { provider: runtime.provider, apiKey: runtime.apiKey, model: runtime.model, effort: runtime.effort } },
  );

  // El intento se registra aunque falle (consumio recursos); un error de nuestro registro no debe romper la respuesta.
  try {
    await db.aiGeneration.create({
      data: {
        userId: args.userId,
        brandId: args.brandId,
        provider: runtime.provider,
        model: (result.ok ? result.model : runtime.model).slice(0, 64),
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        ok: result.ok,
        error: result.ok ? null : result.error.slice(0, 300),
      },
    });
  } catch (e) {
    console.error("[ai] no se pudo registrar el uso", e instanceof Error ? e.message : e);
  }

  return { ...result, usage: { ...usage, used: usage.used + 1 }, engine: { label: runtime.label, model: result.ok ? result.model : runtime.model } };
}
