import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGeminiEngine } from "@/lib/ai/engines/gemini";
import { createOpenAiEngine } from "@/lib/ai/engines/openai";
import { redactKey, type EngineParams } from "@/lib/ai/engines/types";
import { generatePosts, type EngineConfig } from "@/lib/ai/generate";
import type { Engine } from "@/lib/ai/engines/types";
import { setMetaEnv } from "./helpers/meta-env";

beforeEach(() => {
  setMetaEnv({ OPENAI_BASE_URL: undefined, GEMINI_BASE_URL: undefined });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const KEY = "sk-proj-clave-de-prueba-0123456789";
const params: EngineParams = { apiKey: KEY, model: "gpt-6.1-sol", system: "SISTEMA de la marca", user: "Escribe 2 opciones", maxTokens: 16000, effort: "medium" };

type Call = { url: string; init: RequestInit; body: Record<string, unknown> | null };

/** Sustituye fetch por respuestas en cola (la ultima se repite) y anota cada llamada. */
function stubApi(...responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      calls.push({ url: String(input), init, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json", ...r.headers } });
    }),
  );
  return calls;
}

const POSTS_JSON = JSON.stringify({ posts: [{ angle: "beneficio", text: "Hola equipo", hashtags: ["reservi"], image_idea: "foto" }] });

// ---------------------------------------------------------------------------
// OpenAI (Responses API)
// ---------------------------------------------------------------------------

const openaiOk = (over: Record<string, unknown> = {}) => ({
  status: "completed",
  model: "gpt-6.1-sol-2026-09-01",
  output: [
    { type: "reasoning", summary: [] },
    { type: "message", content: [{ type: "output_text", text: POSTS_JSON }] },
  ],
  usage: { input_tokens: 700, output_tokens: 300 },
  ...over,
});

describe("motor OpenAI", () => {
  it("llama a la Responses API con la clave en la cabecera, esquema estricto y sin guardar la conversacion", async () => {
    const calls = stubApi({ body: openaiOk() });
    await createOpenAiEngine().run(params);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].url).not.toContain(KEY);
    const b = calls[0].body!;
    expect(b.model).toBe("gpt-6.1-sol");
    expect(b.store).toBe(false);
    expect(b.max_output_tokens).toBe(16000);
    expect(b.input).toEqual([
      { role: "system", content: "SISTEMA de la marca" },
      { role: "user", content: "Escribe 2 opciones" },
    ]);
    const format = (b.text as { format: Record<string, unknown> }).format;
    expect(format).toMatchObject({ type: "json_schema", strict: true });
    expect((format.schema as { required: string[] }).required).toEqual(["posts"]);
    // No se manda esfuerzo de razonamiento: los modelos que no lo soportan lo rechazan.
    expect(b).not.toHaveProperty("reasoning");
    expect(b).not.toHaveProperty("temperature");
  });

  it("lee el texto del mensaje (saltando el razonamiento) y los tokens", async () => {
    stubApi({ body: openaiOk() });
    const r = await createOpenAiEngine().run(params);
    expect(r).toEqual({ ok: true, text: POSTS_JSON, model: "gpt-6.1-sol-2026-09-01", inputTokens: 700, outputTokens: 300 });
  });

  it("un rechazo del modelo y una respuesta cortada se explican", async () => {
    stubApi({ body: openaiOk({ output: [{ type: "message", content: [{ type: "refusal", refusal: "No puedo ayudar con eso" }] }] }) });
    const refusal = await createOpenAiEngine().run(params);
    expect(!refusal.ok && refusal.error).toMatch(/no quiso redactar/);
    expect(!refusal.ok && refusal.inputTokens).toBe(700);

    stubApi({ body: openaiOk({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) });
    const cut = await createOpenAiEngine().run(params);
    expect(!cut.ok && cut.error).toMatch(/se cortó/);

    stubApi({ body: openaiOk({ status: "incomplete", incomplete_details: { reason: "content_filter" } }) });
    const filtered = await createOpenAiEngine().run(params);
    expect(!filtered.ok && filtered.error).toMatch(/no quiso redactar/);
  });

  it("si el modelo no admite el esquema estricto, reintenta en modo JSON simple con la forma descrita", async () => {
    const calls = stubApi({ status: 400, body: { error: { message: "Invalid schema for response_format 'publicaciones'" } } }, { body: openaiOk() });
    const r = await createOpenAiEngine().run(params);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const retry = calls[1].body!;
    expect((retry.text as { format: { type: string } }).format.type).toBe("json_object");
    const system = (retry.input as { content: string }[])[0].content;
    expect(system).toContain("SISTEMA de la marca");
    expect(system).toContain('{"posts":'); // la forma del JSON se describe en el texto
    expect(system).toContain("JSON"); // el modo JSON simple exige nombrarlo
  });

  it("un 400 que no es del formato no se reintenta", async () => {
    const calls = stubApi({ status: 400, body: { error: { message: "max_output_tokens too large" } } });
    const r = await createOpenAiEngine().run(params);
    expect(calls).toHaveLength(1);
    expect(!r.ok && r.error).toMatch(/rechazó la petición.*max_output_tokens/);
  });

  it("errores de la API en español: clave, permiso, modelo, saldo y saturacion", async () => {
    const err = async (status: number, body: unknown) => {
      stubApi({ status, body, headers: { "retry-after-ms": "0" } });
      const r = await createOpenAiEngine().run(params);
      return !r.ok ? r.error : "";
    };
    expect(await err(401, { error: { message: "Incorrect API key provided", code: "invalid_api_key" } })).toMatch(/clave de GPT \(OpenAI\) no es válida.*Motores de IA/);
    expect(await err(403, { error: { message: "no access" } })).toMatch(/no tiene permiso/);
    expect(await err(404, { error: { message: "The model does not exist", code: "model_not_found" } })).toMatch(/«gpt-6\.1-sol».*no existe/);
    expect(await err(429, { error: { message: "You exceeded your current quota", code: "insufficient_quota" } })).toMatch(/no tiene saldo/);
    expect(await err(429, { error: { message: "Rate limit reached" } })).toMatch(/demasiadas peticiones/);
    expect(await err(503, { error: { message: "overloaded" } })).toMatch(/saturado/);
  });

  it("reintenta limites de uso y errores del servidor (3 intentos), pero no la falta de saldo", async () => {
    const rate = stubApi({ status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after-ms": "0" } });
    await createOpenAiEngine().run(params);
    expect(rate).toHaveLength(3);

    const flaky = stubApi({ status: 500, body: {}, headers: { "retry-after-ms": "0" } }, { body: openaiOk() });
    expect((await createOpenAiEngine().run(params)).ok).toBe(true);
    expect(flaky).toHaveLength(2);

    const quota = stubApi({ status: 429, body: { error: { code: "insufficient_quota", message: "quota" } } });
    await createOpenAiEngine().run(params);
    expect(quota).toHaveLength(1);
  });

  it("una caida de red da un mensaje claro tras reintentar", async () => {
    vi.useFakeTimers();
    const calls = stubApi(new TypeError("fetch failed"));
    const pending = createOpenAiEngine().run(params);
    await vi.runAllTimersAsync();
    const r = await pending;
    expect(calls).toHaveLength(3);
    expect(!r.ok && r.error).toMatch(/No se pudo contactar/);
  });

  it("el mensaje de error nunca contiene la clave (aunque la API la repita)", async () => {
    stubApi({ status: 400, body: { error: { message: `Bad request for key ${KEY}` } } });
    const r = await createOpenAiEngine().run(params);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("lista solo los modelos de texto, sin duplicados y ordenados", async () => {
    const calls = stubApi({
      body: {
        data: [
          { id: "gpt-6.1-sol" },
          { id: "text-embedding-4" },
          { id: "gpt-6-astra" },
          { id: "whisper-2" },
          { id: "gpt-image-3" },
          { id: "gpt-6-astra" },
          { id: "o5-mini" },
          { id: "tts-3" },
          { id: "dall-e-4" },
          { id: "omni-moderation-2" },
        ],
      },
    });
    const r = await createOpenAiEngine().listModels(KEY);
    expect(calls[0].url).toBe("https://api.openai.com/v1/models");
    expect(r).toEqual({ ok: true, models: ["gpt-6-astra", "gpt-6.1-sol", "o5-mini"] });
  });

  it("una clave invalida al listar modelos se explica y no la filtra", async () => {
    stubApi({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } });
    const r = await createOpenAiEngine().listModels(KEY);
    expect(!r.ok && r.error).toMatch(/no es válida/);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});

// ---------------------------------------------------------------------------
// Gemini (generateContent)
// ---------------------------------------------------------------------------

const GKEY = "AIzaSyClaveDePruebaDeGemini0123456789";
const gparams: EngineParams = { ...params, apiKey: GKEY, model: "gemini-3.8-flash" };
const geminiOk = (over: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts: [{ text: "pensando...", thought: true }, { text: POSTS_JSON }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 250, thoughtsTokenCount: 150 },
  modelVersion: "gemini-3.8-flash-001",
  ...over,
});

describe("motor Gemini", () => {
  it("llama a generateContent con la clave en una cabecera (nunca en la URL) y pide JSON", async () => {
    const calls = stubApi({ body: geminiOk() });
    await createGeminiEngine().run(gparams);

    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(calls[0].url).not.toContain(GKEY);
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe(GKEY);
    const b = calls[0].body as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: { text: string }[] }[];
      generationConfig: Record<string, unknown>;
    };
    expect(b.systemInstruction.parts[0].text).toContain("SISTEMA de la marca");
    expect(b.systemInstruction.parts[0].text).toContain('{"posts":'); // forma del JSON
    expect(b.contents).toEqual([{ role: "user", parts: [{ text: "Escribe 2 opciones" }] }]);
    expect(b.generationConfig).toEqual({ responseMimeType: "application/json", maxOutputTokens: 16000 });
  });

  it("acepta el nombre con el prefijo models/ y protege la ruta de caracteres raros", async () => {
    const calls = stubApi({ body: geminiOk() });
    await createGeminiEngine().run({ ...gparams, model: "models/gemini-3.8-flash" });
    expect(calls[0].url).toContain("/v1beta/models/gemini-3.8-flash:generateContent");
    const evil = stubApi({ body: geminiOk() });
    await createGeminiEngine().run({ ...gparams, model: "x/../../otra-ruta?key=1" });
    expect(evil[0].url).not.toContain("../");
    expect(evil[0].url).not.toContain("?key=1");
  });

  it("une las partes de texto (sin los pensamientos) y suma los tokens de pensar como salida", async () => {
    stubApi({ body: geminiOk() });
    const r = await createGeminiEngine().run(gparams);
    expect(r).toEqual({ ok: true, text: POSTS_JSON, model: "gemini-3.8-flash-001", inputTokens: 800, outputTokens: 400 });
  });

  it("bloqueos por seguridad, respuesta cortada y sin respuesta", async () => {
    stubApi({ body: geminiOk({ candidates: [{ finishReason: "SAFETY" }] }) });
    expect((await createGeminiEngine().run(gparams))).toMatchObject({ ok: false, error: expect.stringMatching(/no quiso redactar/), inputTokens: 800 });

    stubApi({ body: geminiOk({ candidates: [{ content: { parts: [{ text: '{"posts":[' }] }, finishReason: "MAX_TOKENS" }] }) });
    expect((await createGeminiEngine().run(gparams))).toMatchObject({ ok: false, error: expect.stringMatching(/se cortó/) });

    stubApi({ body: { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 20 } } });
    expect((await createGeminiEngine().run(gparams))).toMatchObject({ ok: false, error: expect.stringMatching(/no quiso redactar/) });

    stubApi({ body: { candidates: [] } });
    expect((await createGeminiEngine().run(gparams))).toMatchObject({ ok: false, error: expect.stringMatching(/ninguna respuesta/) });
  });

  it("errores de la API en español; Google responde 400 (no 401) cuando la clave es invalida", async () => {
    const err = async (status: number, body: unknown) => {
      stubApi({ status, body, headers: { "retry-after-ms": "0" } });
      const r = await createGeminiEngine().run(gparams);
      return !r.ok ? r.error : "";
    };
    expect(await err(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } })).toMatch(/clave de Gemini \(Google\) no es válida/);
    expect(await err(400, { error: { code: 400, message: "x", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } })).toMatch(/no es válida/);
    expect(await err(403, { error: { message: "denied" } })).toMatch(/no tiene permiso/);
    expect(await err(404, { error: { message: "models/x is not found" } })).toMatch(/«gemini-3\.8-flash».*no existe/);
    expect(await err(429, { error: { status: "RESOURCE_EXHAUSTED" } })).toMatch(/demasiadas peticiones/);
    expect(await err(500, { error: { message: "internal" } })).toMatch(/saturado/);
    expect(await err(400, { error: { message: "Unsupported field generationConfig.foo" } })).toMatch(/rechazó la petición.*generationConfig/);
  });

  it("el mensaje de error nunca contiene la clave", async () => {
    stubApi({ status: 400, body: { error: { message: `Invalid key ${GKEY}` } } });
    const r = await createGeminiEngine().run(gparams);
    expect(JSON.stringify(r)).not.toContain(GKEY);
  });

  it("lista solo los modelos de texto que generan contenido, sin el prefijo models/", async () => {
    const calls = stubApi({
      body: {
        models: [
          { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
          { name: "models/gemini-4-argon", supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-5", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-embedding-2", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-3.8-flash-image", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3-live", supportedGenerationMethods: ["bidiGenerateContent"] },
          { name: "models/imagen-5", supportedGenerationMethods: ["predict"] },
        ],
      },
    });
    const r = await createGeminiEngine().listModels(GKEY);
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe(GKEY);
    expect(r).toEqual({ ok: true, models: ["gemini-3.8-flash", "gemini-4-argon"] });
  });
});

// ---------------------------------------------------------------------------
// Lo comun a todos los motores
// ---------------------------------------------------------------------------

describe("generatePosts con cualquier motor", () => {
  const brand = { name: "Smartec", description: "Tecnología para el hogar.", language: "es", avoid: "gratis" };
  const input = { brand, brief: "Lanzamos un cargador rápido", count: 2, platform: "instagram" as const };

  const engineReturning = (text: string, seen: EngineParams[] = []): Engine => ({
    id: "openai",
    async run(p) {
      seen.push(p);
      return { ok: true, text, model: p.model, inputTokens: 10, outputTokens: 5 };
    },
    async listModels() {
      return { ok: true, models: [] };
    },
  });
  const cfg = (provider: EngineConfig["provider"]): EngineConfig => ({ provider, apiKey: KEY, model: "m", effort: "low" });

  it("las reglas de la marca (palabras vetadas, hashtags, limites) se aplican igual con GPT o Gemini", async () => {
    const text = JSON.stringify({
      posts: [
        { angle: "a", text: "Envío GRATIS hoy", hashtags: [], image_idea: "" },
        { angle: "b", text: "Carga más rápido", hashtags: ["tecnologia", "#Tecnologia"], image_idea: "foto" },
      ],
    });
    for (const provider of ["openai", "gemini"] as const) {
      const r = await generatePosts(input, { config: cfg(provider), engine: engineReturning(text) });
      expect(r.ok && r.posts.map((p) => p.fullText)).toEqual(["Carga más rápido\n\n#tecnologia"]);
      expect(r.ok && r.discarded).toBe(1);
    }
  });

  it("el perfil de marca y la peticion llegan al motor; con GPT y Gemini se deja holgura de tokens para pensar", async () => {
    const seen: EngineParams[] = [];
    await generatePosts(input, { config: cfg("gemini"), engine: engineReturning(POSTS_JSON, seen) });
    expect(seen[0].system).toContain("«Smartec»");
    expect(seen[0].user).toContain("cargador rápido");
    expect(seen[0].maxTokens).toBe(16000);
    expect(seen[0].apiKey).toBe(KEY);
  });

  it("texto que no es JSON o con otra forma da errores claros y conserva los tokens gastados", async () => {
    const notJson = await generatePosts(input, { config: cfg("openai"), engine: engineReturning("Claro, aquí tienes ideas") });
    const wrong = await generatePosts(input, { config: cfg("openai"), engine: engineReturning('{"posts":[{"text":"x"}]}') });
    expect(!notJson.ok && notJson.error).toMatch(/no se pudo leer/);
    expect(!notJson.ok && notJson.inputTokens).toBe(10);
    expect(!wrong.ok && wrong.error).toMatch(/formato inesperado/);
  });

  it("un fallo del motor se devuelve tal cual (ya viene en español)", async () => {
    const failing: Engine = { id: "gemini", run: async () => ({ ok: false, error: "La clave de Gemini (Google) no es válida." }), listModels: async () => ({ ok: true, models: [] }) };
    const r = await generatePosts(input, { config: cfg("gemini"), engine: failing });
    expect(r).toEqual({ ok: false, error: "La clave de Gemini (Google) no es válida." });
  });
});

describe("redactKey", () => {
  it("quita la clave de cualquier parte del texto y no rompe con una clave vacia", () => {
    expect(redactKey(`a ${KEY} b ${KEY}`, KEY)).toBe("a •••• b ••••");
    expect(redactKey("sin clave", "")).toBe("sin clave");
  });
});
