import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { PROVIDERS } from "@/lib/ai/catalog";
import {
  msgBadKey,
  msgNoCredit,
  msgNoModel,
  msgNoPermission,
  msgRejected,
  MSG_BUSY,
  MSG_NETWORK,
  MSG_RATE,
  MSG_REFUSAL,
  MSG_TRUNCATED,
  MSG_UNKNOWN,
} from "@/lib/ai/engines/messages";
import { redactKey, type Engine, type EngineParams, type EngineResult } from "@/lib/ai/engines/types";
import { AI_OUTPUT_JSON_SCHEMA } from "@/lib/ai/types";

/** Respaldo ante rechazos del servidor: si el modelo declina por seguridad, Anthropic reintenta con otro. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const LABEL = PROVIDERS.anthropic.label;

export type AiClient = Pick<Anthropic, "beta">;

/** Mensaje en español para cada tipo de fallo de la API (sin filtrar datos sensibles). */
export function describeAnthropicError(e: unknown, model: string): string {
  if (e instanceof Anthropic.AuthenticationError) return msgBadKey(LABEL);
  if (e instanceof Anthropic.PermissionDeniedError) return msgNoPermission(LABEL);
  if (e instanceof Anthropic.NotFoundError) return msgNoModel(model);
  if (e instanceof Anthropic.RateLimitError) return MSG_RATE;
  if (e instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(e.message)) return msgNoCredit("Anthropic", "console.anthropic.com");
    return msgRejected(e.message);
  }
  if (e instanceof Anthropic.APIConnectionError) return MSG_NETWORK;
  if (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500) return MSG_BUSY;
  return MSG_UNKNOWN;
}

/** Motor de Claude. `client` solo se inyecta en las pruebas; si no, se crea uno con la clave de cada llamada. */
export function createAnthropicEngine(client?: AiClient): Engine {
  const clientFor = (apiKey: string) => new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });

  return {
    id: "anthropic",

    async run(p: EngineParams): Promise<EngineResult> {
      const api: AiClient = client ?? clientFor(p.apiKey);
      const params = {
        model: p.model,
        max_tokens: p.maxTokens,
        // Perfil de marca + reglas: igual en cada peticion de la misma marca, asi que se puede cachear.
        system: [{ type: "text" as const, text: p.system, cache_control: { type: "ephemeral" as const } }],
        messages: [{ role: "user" as const, content: p.user }],
        // Claude 5.5 siempre piensa; el esfuerzo controla cuanto. La salida va en JSON validado por la API.
        output_config: { effort: p.effort, format: { type: "json_schema" as const, schema: AI_OUTPUT_JSON_SCHEMA } },
      };

      try {
        let response;
        try {
          response = await api.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" });
        } catch (e) {
          // Si la cuenta o el modelo no aceptan el respaldo, se reintenta sin el: es una mejora, no un requisito.
          if (e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
            response = await api.beta.messages.create(params);
          } else {
            throw e;
          }
        }

        const inputTokens =
          response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0);
        const outputTokens = response.usage.output_tokens;
        if (response.stop_reason === "refusal") return { ok: false, error: MSG_REFUSAL, inputTokens, outputTokens };
        if (response.stop_reason === "max_tokens") return { ok: false, error: MSG_TRUNCATED, inputTokens, outputTokens };

        const text = response.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        return { ok: true, text, model: response.model ?? p.model, inputTokens, outputTokens };
      } catch (e) {
        return { ok: false, error: redactKey(describeAnthropicError(e, p.model), p.apiKey) };
      }
    },

    async listModels(apiKey) {
      try {
        const ids: string[] = [];
        for await (const m of clientFor(apiKey).models.list({ limit: 100 })) {
          ids.push(m.id);
          if (ids.length >= 300) break;
        }
        return { ok: true, models: ids.filter((id) => id.startsWith("claude-")).sort() };
      } catch (e) {
        return { ok: false, error: redactKey(describeAnthropicError(e, ""), apiKey) };
      }
    },
  };
}
