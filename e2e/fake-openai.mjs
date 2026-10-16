// Servidor que imita la API de OpenAI (POST /v1/responses y GET /v1/models) para las pruebas, sin gastar dinero ni
// necesitar clave real. Valida clave, modelo y formato de salida, y responde segun una palabra clave que la prueba
// escribe en la peticion (igual que fake-anthropic.mjs).

import http from "node:http";

export const FAKE_OPENAI_KEY = "sk-proj-clave-falsa-de-openai-0000000000";

const ANGLES = ["beneficio", "historia", "pregunta", "oferta"];

const errorBody = (message, code = null, type = "invalid_request_error") => ({ error: { message, type, code, param: null } });

function okBody(items, extra = {}) {
  return {
    id: "resp_fake_0001",
    object: "response",
    status: "completed",
    model: "gpt-6.1-sol-2026-09-01",
    output: [
      { id: "rs_1", type: "reasoning", summary: [] },
      { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ posts: items }), annotations: [] }] },
    ],
    usage: { input_tokens: 1100, output_tokens: 520, total_tokens: 1620 },
    ...extra,
  };
}

export function startFakeOpenAi(port) {
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const apiKey = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    requests.push({ method: req.method, path: url.pathname, apiKey, body });

    if (apiKey !== FAKE_OPENAI_KEY) return send(401, errorBody("Incorrect API key provided: " + apiKey.slice(0, 8) + "****", "invalid_api_key"));

    if (url.pathname === "/v1/models" && req.method === "GET") {
      const ids = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "text-embedding-4", "whisper-2", "gpt-image-3", "tts-3", "omni-moderation-2"];
      return send(200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "openai" })) });
    }
    if (url.pathname !== "/v1/responses" || req.method !== "POST") return send(404, errorBody(`Ruta no soportada: ${url.pathname}`));

    if (body.model === "modelo-inexistente") return send(404, errorBody("The model `modelo-inexistente` does not exist or you do not have access to it.", "model_not_found"));

    const userText = String(body.input?.at(-1)?.content ?? "");
    const brief = (userText.match(/"""\n([\s\S]*?)\n"""/) ?? [])[1] ?? "";
    const count = Number((userText.match(/Escribe (\d+) /) ?? [])[1] ?? 1);

    if (brief.includes("ERROR401")) return send(401, errorBody("Incorrect API key provided", "invalid_api_key"));
    if (brief.includes("LIMITE429")) return send(429, errorBody("Rate limit reached for requests", "rate_limit_exceeded", "requests"), { "retry-after-ms": "5" });
    if (brief.includes("SINCREDITO")) return send(429, errorBody("You exceeded your current quota, please check your plan and billing details.", "insufficient_quota", "insufficient_quota"));
    // Simula un modelo que no admite el esquema estricto: solo acepta el modo JSON simple.
    if (brief.includes("FORMATO400") && body.text?.format?.type === "json_schema") {
      return send(400, errorBody("Invalid schema for response_format 'publicaciones': this model does not support strict structured outputs."));
    }
    if (brief.includes("REHUSAR")) {
      return send(200, okBody([], { output: [{ type: "message", content: [{ type: "refusal", refusal: "Lo siento, no puedo ayudar con eso." }] }] }));
    }
    if (brief.includes("CORTADO")) return send(200, okBody([], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }));
    if (brief.includes("BASURA")) {
      return send(200, okBody([], { output: [{ type: "message", content: [{ type: "output_text", text: "Claro, aquí tienes algunas ideas: 1) algo 2) otra cosa" }] }] }));
    }

    const items = Array.from({ length: count }, (_, i) => ({
      angle: ANGLES[i % ANGLES.length],
      text: `GPT escribió: ${brief.slice(0, 70).trim()} (opción ${i + 1})`,
      hashtags: ["reservi", "#Reservas"],
      image_idea: `Foto ${i + 1} del negocio`,
    }));
    if (brief.includes("VETADA")) items[0].text = "Reserva GRATIS hoy mismo";
    return send(200, okBody(items));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        close: () => new Promise((r) => server.close(() => r())),
        requests: () => requests,
      }),
    );
  });
}
