import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicEngine, describeAnthropicError, type AiClient } from "@/lib/ai/engines/anthropic";
import { generatePosts as generate, processPosts, type EngineConfig, type GenerateInput } from "@/lib/ai/generate";
import type { BrandProfile } from "@/lib/ai/types";

const config: EngineConfig = { provider: "anthropic", apiKey: "sk-ant-prueba-0000000000", model: "claude-opus-5-5", effort: "medium" };

/** Genera con el motor de Claude y un cliente simulado (el resto del flujo es el mismo para cualquier motor). */
const generatePosts = (inp: GenerateInput, deps: { client: AiClient; config: EngineConfig }) =>
  generate(inp, { config: deps.config, engine: createAnthropicEngine(deps.client) });
const brand: BrandProfile = { name: "Smartec", description: "Tecnología para el hogar y la oficina.", language: "es", avoid: "gratis" };
const input = { brand, brief: "Lanzamos un nuevo cargador rápido", count: 2, platform: "instagram" as const };

type Item = { angle: string; text: string; hashtags: string[]; image_idea: string };
const item = (over: Partial<Item> = {}): Item => ({ angle: "beneficio", text: "Carga tu teléfono en minutos.", hashtags: ["tecnologia", "#Cargador"], image_idea: "Foto del cargador", ...over });

/** Respuesta de la API simulada. */
const reply = (items: Item[], extra: Record<string, unknown> = {}) => ({
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify({ posts: items }) }],
  usage: { input_tokens: 900, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...extra,
});

function fakeClient(...responses: Array<unknown | Error>) {
  const create = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) create.mockRejectedValueOnce(r);
    else create.mockResolvedValueOnce(r);
  }
  return { client: { beta: { messages: { create } } } as unknown as AiClient, create };
}

const apiError = (status: number, message: string) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message } }, message, new Headers());

describe("generatePosts: la peticion a Claude", () => {
  it("usa el modelo configurado, salida JSON estructurada, esfuerzo y respaldo ante rechazos", async () => {
    const { client, create } = fakeClient(reply([item()]));
    await generatePosts(input, { client, config });

    expect(create).toHaveBeenCalledTimes(1);
    const params = create.mock.calls[0][0];
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.max_tokens).toBe(8000);
    expect(params.output_config.effort).toBe("medium");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.output_config.format.schema.required).toEqual(["posts"]);
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    // El perfil de marca va en el sistema (cacheable) y la peticion en el mensaje del usuario.
    expect(params.system[0].text).toContain("«Smartec»");
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe("user");
    expect(params.messages[0].content).toContain("nuevo cargador rápido");
    expect(params.messages[0].content).toContain("Escribe 2 opciones distintas.");
  });

  it("no manda parametros que el modelo rechaza (thinking, temperature, prefill, tool_choice forzado)", async () => {
    const { client, create } = fakeClient(reply([item()]));
    await generatePosts(input, { client, config });
    const params = create.mock.calls[0][0];
    for (const k of ["thinking", "temperature", "top_p", "top_k", "tool_choice", "tools"]) expect(params).not.toHaveProperty(k);
    expect(params.messages.at(-1).role).toBe("user");
  });

  it("si la API rechaza el respaldo, reintenta sin el", async () => {
    const { client, create } = fakeClient(apiError(400, "fallbacks is not supported for this organization"), reply([item()]));
    const res = await generatePosts(input, { client, config });
    expect(res.ok).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    const retry = create.mock.calls[1][0];
    expect(retry).not.toHaveProperty("fallbacks");
    expect(retry).not.toHaveProperty("betas");
  });

  it("un 400 que no es del respaldo no se reintenta", async () => {
    const { client, create } = fakeClient(apiError(400, "max_tokens too large"));
    const res = await generatePosts(input, { client, config });
    expect(res.ok).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("usa 8000 tokens de salida con Claude y deja mas holgura a los motores que piensan antes de responder", async () => {
    const { client, create } = fakeClient(reply([item()]));
    await generatePosts(input, { client, config });
    expect(create.mock.calls[0][0].max_tokens).toBe(8000);
  });
});

describe("generatePosts: la respuesta", () => {
  it("devuelve las opciones limpias, con hashtags normalizados y el texto final armado", async () => {
    const { client } = fakeClient(reply([item({ hashtags: ["tecnologia", "#Tecnologia", "Cargador Rápido"] })]));
    const res = await generatePosts(input, { client, config });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.posts).toHaveLength(1);
    expect(res.posts[0]).toMatchObject({
      angle: "beneficio",
      text: "Carga tu teléfono en minutos.",
      hashtags: ["#tecnologia", "#CargadorRápido"],
      imageIdea: "Foto del cargador",
      fullText: "Carga tu teléfono en minutos.\n\n#tecnologia #CargadorRápido",
      warnings: [],
    });
    expect(res.inputTokens).toBe(900);
    expect(res.outputTokens).toBe(400);
    expect(res.model).toBe("claude-opus-5-5");
  });

  it("cuenta los tokens guardados en cache como entrada", async () => {
    const { client } = fakeClient(reply([item()], { usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 800, cache_read_input_tokens: 0 } }));
    const res = await generatePosts(input, { client, config });
    expect(res.ok && res.inputTokens).toBe(900);
  });

  it("descarta las opciones con palabras vetadas y avisa cuantas", async () => {
    const { client } = fakeClient(reply([item({ text: "¡Envío GRATIS hoy!" }), item({ text: "Carga más rápido que nunca." })]));
    const res = await generatePosts(input, { client, config });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.posts.map((p) => p.text)).toEqual(["Carga más rápido que nunca."]);
    expect(res.discarded).toBe(1);
  });

  it("si todas incumplen las reglas, falla con un mensaje que lo explica", async () => {
    const { client } = fakeClient(reply([item({ text: "Gratis para ti" }), item({ hashtags: ["gratis"] })]));
    const res = await generatePosts(input, { client, config });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/palabras que pediste evitar/);
  });

  it("detecta una palabra vetada que solo aparece en los hashtags", async () => {
    const { client } = fakeClient(reply([item({ hashtags: ["Gratis"] }), item({ text: "Otra opción válida" })]));
    const res = await generatePosts(input, { client, config });
    expect(res.ok && res.posts.map((p) => p.text)).toEqual(["Otra opción válida"]);
  });

  it("recorta a la cantidad pedida y quita las repetidas", async () => {
    const { client } = fakeClient(reply([item({ text: "A" }), item({ text: "A" }), item({ text: "B" }), item({ text: "C" })]));
    const res = await generatePosts({ ...input, count: 2 }, { client, config });
    expect(res.ok && res.posts.map((p) => p.text)).toEqual(["A", "B"]);
  });

  it("avisa si supera el limite de caracteres de la plataforma", async () => {
    const { client } = fakeClient(reply([item({ text: "x".repeat(2300) })]));
    const res = await generatePosts(input, { client, config });
    expect(res.ok && res.posts[0].warnings[0]).toMatch(/límite es 2200/);
  });

  it("avisa de los enlaces en Instagram pero no en Facebook", async () => {
    const withLink = item({ text: "Mira https://smartec.example/cargador" });
    const ig = await generatePosts(input, { client: fakeClient(reply([withLink])).client, config });
    const fb = await generatePosts({ ...input, platform: "facebook" }, { client: fakeClient(reply([withLink])).client, config });
    expect(ig.ok && ig.posts[0].warnings.join()).toMatch(/enlace/);
    expect(fb.ok && fb.posts[0].warnings).toEqual([]);
  });

  it("limita los hashtags segun la plataforma", async () => {
    const many = Array.from({ length: 15 }, (_, i) => `tag${i}`);
    const fb = await generatePosts({ ...input, platform: "facebook" }, { client: fakeClient(reply([item({ hashtags: many })])).client, config });
    const ig = await generatePosts(input, { client: fakeClient(reply([item({ hashtags: many })])).client, config });
    expect(fb.ok && fb.posts[0].hashtags).toHaveLength(5);
    expect(ig.ok && ig.posts[0].hashtags).toHaveLength(10);
  });

  it("ignora las opciones vacias", async () => {
    const { client } = fakeClient(reply([item({ text: "   " }), item({ text: "Texto bueno" })]));
    const res = await generatePosts(input, { client, config });
    expect(res.ok && res.posts.map((p) => p.text)).toEqual(["Texto bueno"]);
  });
});

describe("generatePosts: respuestas anomalas", () => {
  it("un rechazo del modelo (refusal) se explica y no se lee el contenido", async () => {
    const { client } = fakeClient(reply([item()], { stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" } }));
    const res = await generatePosts(input, { client, config });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no quiso redactar/);
  });

  it("una respuesta cortada por max_tokens se avisa", async () => {
    const { client } = fakeClient(reply([item()], { stop_reason: "max_tokens" }));
    const res = await generatePosts(input, { client, config });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/se cortó/);
  });

  it("texto que no es JSON y JSON con otra forma dan errores distintos y claros", async () => {
    const bad = (text: string) => ({ ...reply([]), content: [{ type: "text", text }] });
    const notJson = await generatePosts(input, { client: fakeClient(bad("hola")).client, config });
    const wrongShape = await generatePosts(input, { client: fakeClient(bad('{"posts":[{"text":"x"}]}')).client, config });
    expect(!notJson.ok && notJson.error).toMatch(/no se pudo leer/);
    expect(!wrongShape.ok && wrongShape.error).toMatch(/formato inesperado/);
  });

  it("aun cuando falla el formato, informa los tokens gastados (cuestan igual)", async () => {
    const res = await generatePosts(input, { client: fakeClient({ ...reply([]), content: [{ type: "text", text: "no es json" }] }).client, config });
    expect(!res.ok && res.inputTokens).toBe(900);
  });

  it("une varios bloques de texto antes de leer el JSON", async () => {
    const json = JSON.stringify({ posts: [item()] });
    const res = await generatePosts(input, {
      client: fakeClient({ ...reply([]), content: [{ type: "text", text: json.slice(0, 20) }, { type: "text", text: json.slice(20) }] }).client,
      config,
    });
    expect(res.ok).toBe(true);
  });
});

describe("errores de la API en español, sin filtrar datos sensibles", () => {
  const msg = (status: number, text: string) => describeAnthropicError(apiError(status, text), "claude-opus-5-5");

  it("clave invalida, sin permiso, modelo inexistente, limite de uso y saturacion", () => {
    expect(msg(401, "invalid x-api-key")).toMatch(/clave de Claude.*no es válida.*Motores de IA/);
    expect(msg(403, "forbidden")).toMatch(/no tiene permiso/);
    expect(msg(404, "model: claude-x")).toMatch(/«claude-opus-5-5».*Motores de IA/);
    expect(msg(429, "rate")).toMatch(/demasiadas peticiones/);
    expect(msg(529, "overloaded")).toMatch(/saturado/);
    expect(msg(500, "boom")).toMatch(/saturado/);
  });

  it("falta de saldo se explica con el paso a seguir", () => {
    expect(msg(400, "Your credit balance is too low to access the Anthropic API")).toMatch(/no tiene saldo/);
  });

  it("un 400 cualquiera muestra un resumen corto del motivo", () => {
    expect(msg(400, "messages: text content blocks must be non-empty")).toMatch(/non-empty/);
    expect(msg(400, "y".repeat(500)).length).toBeLessThan(220);
  });

  it("un error de red y uno desconocido tienen mensaje propio", () => {
    expect(describeAnthropicError(new Anthropic.APIConnectionError({ message: "ECONNRESET" }), "m")).toMatch(/No se pudo contactar/);
    expect(describeAnthropicError(new Error("raro"), "m")).toMatch(/error inesperado/);
  });

  it("el error final nunca contiene la clave de la API", async () => {
    const { client } = fakeClient(apiError(401, `invalid x-api-key ${config.apiKey}`));
    const res = await generatePosts(input, { client, config });
    expect(JSON.stringify(res)).not.toContain(config.apiKey);
  });
});

describe("processPosts", () => {
  it("cuenta como descartadas las vacias, repetidas y vetadas", () => {
    const { posts, discarded } = processPosts([item({ text: "" }), item({ text: "ok" }), item({ text: "ok" }), item({ text: "gratis" })], { brand, platform: "facebook", count: 5 });
    expect(posts).toHaveLength(1);
    expect(discarded).toBe(3);
  });
});
