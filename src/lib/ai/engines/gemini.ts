import "server-only";
import { PROVIDERS } from "@/lib/ai/catalog";
import { asArray, asNumber, asString, pick, requestJson, type HttpResult } from "@/lib/ai/engines/http";
import {
  JSON_SHAPE_HINT,
  msgBadKey,
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
import { env } from "@/lib/env";

const LABEL = PROVIDERS.gemini.label;
const baseUrl = () => (env().GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "");
// La clave va en una cabecera y no en la URL (asi no queda en registros ni en historiales de proxys).
const auth = (apiKey: string) => ({ "x-goog-api-key": apiKey });

/** Acepta «gemini-3.8-flash» y «models/gemini-3.8-flash». */
const bareModel = (model: string) => model.replace(/^models\//, "");

/** Mensaje en español para una respuesta de error de la API de Gemini. */
export function describeGeminiError(r: HttpResult, model: string): string {
  if (r.net) return MSG_NETWORK;
  const message = asString(pick(r.body, "error", "message"));
  // Google responde 400 (no 401) cuando la clave no es valida.
  if (r.status === 401 || /api key not valid|API_KEY_INVALID/i.test(message) || /API_KEY_INVALID/.test(JSON.stringify(pick(r.body, "error", "details") ?? ""))) {
    return msgBadKey(LABEL);
  }
  if (r.status === 403) return msgNoPermission(LABEL);
  if (r.status === 404) return msgNoModel(model);
  if (r.status === 429) return MSG_RATE;
  if (r.status === 400) return msgRejected(message || "petición no válida");
  if (r.status >= 500) return MSG_BUSY;
  return MSG_UNKNOWN;
}

const BLOCKED_FINISH = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);
const NOT_TEXT = /(embedding|tts|image|live|audio|robotics|computer-use|aqa)/i;

export function createGeminiEngine(): Engine {
  return {
    id: "gemini",

    async run(p: EngineParams): Promise<EngineResult> {
      const model = bareModel(p.model);
      const r = await requestJson(`${baseUrl()}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: auth(p.apiKey),
        body: {
          systemInstruction: { parts: [{ text: `${p.system}\n\n${JSON_SHAPE_HINT}` }] },
          contents: [{ role: "user", parts: [{ text: p.user }] }],
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: p.maxTokens },
        },
      });

      const fail = (error: string, usage?: { i: number; o: number }): EngineResult => ({
        ok: false,
        error: redactKey(error, p.apiKey),
        ...(usage ? { inputTokens: usage.i, outputTokens: usage.o } : {}),
      });
      if (r.net || r.status >= 400) return fail(describeGeminiError(r, model));

      const body = r.body;
      // Los tokens de «pensar» tambien se cobran como salida.
      const usage = {
        i: asNumber(pick(body, "usageMetadata", "promptTokenCount")),
        o: asNumber(pick(body, "usageMetadata", "candidatesTokenCount")) + asNumber(pick(body, "usageMetadata", "thoughtsTokenCount")),
      };
      const candidate = asArray(pick(body, "candidates"))[0];
      if (!candidate) {
        return fail(pick(body, "promptFeedback", "blockReason") ? MSG_REFUSAL : msgRejected("la IA no devolvió ninguna respuesta"), usage);
      }
      const finish = asString(pick(candidate, "finishReason"));
      if (BLOCKED_FINISH.has(finish)) return fail(MSG_REFUSAL, usage);
      if (finish === "MAX_TOKENS") return fail(MSG_TRUNCATED, usage);

      const text = asArray(pick(candidate, "content", "parts"))
        .filter((part) => pick(part, "thought") !== true)
        .map((part) => asString(pick(part, "text")))
        .join("");
      return { ok: true, text, model: asString(pick(body, "modelVersion")) || model, inputTokens: usage.i, outputTokens: usage.o };
    },

    async listModels(apiKey) {
      const r = await requestJson(`${baseUrl()}/v1beta/models?pageSize=1000`, { method: "GET", headers: auth(apiKey) });
      if (r.net || r.status >= 400) return { ok: false, error: redactKey(describeGeminiError(r, ""), apiKey) };
      const ids = asArray(pick(r.body, "models"))
        .filter((m) => asArray(pick(m, "supportedGenerationMethods")).includes("generateContent"))
        .map((m) => bareModel(asString(pick(m, "name"))))
        .filter((id) => id.startsWith("gemini") && !NOT_TEXT.test(id));
      return { ok: true, models: [...new Set(ids)].sort() };
    },
  };
}
