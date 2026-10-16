import "server-only";
import { PROVIDERS } from "@/lib/ai/catalog";
import { asArray, asNumber, asString, pick, requestJson, type HttpResult } from "@/lib/ai/engines/http";
import {
  JSON_SHAPE_HINT,
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
import { env } from "@/lib/env";

const LABEL = PROVIDERS.openai.label;
const baseUrl = () => (env().OPENAI_BASE_URL ?? "https://api.openai.com").replace(/\/$/, "");
const auth = (apiKey: string) => ({ authorization: `Bearer ${apiKey}` });

/** Mensaje en español para una respuesta de error de la API de OpenAI. */
export function describeOpenAiError(r: HttpResult, model: string): string {
  if (r.net) return MSG_NETWORK;
  const message = asString(pick(r.body, "error", "message"));
  const code = asString(pick(r.body, "error", "code"));
  if (r.status === 401) return msgBadKey(LABEL);
  if (r.status === 403) return msgNoPermission(LABEL);
  if (r.status === 404 || code === "model_not_found") return msgNoModel(model);
  if (r.status === 429) return code === "insufficient_quota" ? msgNoCredit("OpenAI", "platform.openai.com/settings/organization/billing") : MSG_RATE;
  if (r.status === 400) return msgRejected(message || "petición no válida");
  if (r.status >= 500) return MSG_BUSY;
  return MSG_UNKNOWN;
}

/** Un 429 por falta de saldo no se arregla esperando: no se reintenta. */
const noRetry = (status: number, body: unknown) => status === 429 && asString(pick(body, "error", "code")) === "insufficient_quota";

/** Un 400 que se queja del formato de salida (esquema estricto no soportado por el modelo): se puede reintentar en modo JSON simple. */
const isFormatComplaint = (r: HttpResult) =>
  !r.net && r.status === 400 && /response_format|text\.format|json_schema|schema|structured/i.test(asString(pick(r.body, "error", "message")));

const TEXT_MODEL = /^(gpt|chatgpt|o\d)/i;
const NOT_TEXT = /(embedding|tts|whisper|dall-e|image|audio|realtime|transcribe|moderation|search|diarize|sora|computer-use)/i;

export function createOpenAiEngine(): Engine {
  return {
    id: "openai",

    async run(p: EngineParams): Promise<EngineResult> {
      const send = (format: unknown, system: string) =>
        requestJson(
          `${baseUrl()}/v1/responses`,
          {
            method: "POST",
            headers: auth(p.apiKey),
            body: {
              model: p.model,
              store: false,
              max_output_tokens: p.maxTokens,
              input: [
                { role: "system", content: system },
                { role: "user", content: p.user },
              ],
              text: { format },
            },
          },
          { noRetry },
        );

      let r = await send({ type: "json_schema", name: "publicaciones", strict: true, schema: AI_OUTPUT_JSON_SCHEMA }, p.system);
      if (isFormatComplaint(r)) {
        // Algunos modelos no admiten el esquema estricto: se pide JSON simple y se valida igual al recibirlo.
        r = await send({ type: "json_object" }, `${p.system}\n\n${JSON_SHAPE_HINT}`);
      }

      const fail = (error: string, usage?: { i: number; o: number }): EngineResult => ({
        ok: false,
        error: redactKey(error, p.apiKey),
        ...(usage ? { inputTokens: usage.i, outputTokens: usage.o } : {}),
      });
      if (r.net || r.status >= 400) return fail(describeOpenAiError(r, p.model));

      const body = r.body;
      const usage = { i: asNumber(pick(body, "usage", "input_tokens")), o: asNumber(pick(body, "usage", "output_tokens")) };
      const status = asString(pick(body, "status"));
      if (status === "failed") return fail(msgRejected(asString(pick(body, "error", "message")) || "la IA no pudo completar la petición"), usage);
      if (status === "incomplete") {
        return fail(asString(pick(body, "incomplete_details", "reason")) === "content_filter" ? MSG_REFUSAL : MSG_TRUNCATED, usage);
      }

      let text = "";
      for (const item of asArray(pick(body, "output"))) {
        if (asString(pick(item, "type")) !== "message") continue; // los bloques de razonamiento no llevan texto para el usuario
        for (const part of asArray(pick(item, "content"))) {
          if (asString(pick(part, "type")) === "refusal") return fail(MSG_REFUSAL, usage);
          if (asString(pick(part, "type")) === "output_text") text += asString(pick(part, "text"));
        }
      }
      return { ok: true, text, model: asString(pick(body, "model")) || p.model, inputTokens: usage.i, outputTokens: usage.o };
    },

    async listModels(apiKey) {
      const r = await requestJson(`${baseUrl()}/v1/models`, { method: "GET", headers: auth(apiKey) });
      if (r.net || r.status >= 400) return { ok: false, error: redactKey(describeOpenAiError(r, ""), apiKey) };
      const ids = asArray(pick(r.body, "data"))
        .map((m) => asString(pick(m, "id")))
        .filter((id) => id && TEXT_MODEL.test(id) && !NOT_TEXT.test(id));
      return { ok: true, models: [...new Set(ids)].sort() };
    },
  };
}
