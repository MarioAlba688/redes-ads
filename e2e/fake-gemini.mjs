// Servidor que imita la API de Gemini (POST /v1beta/models/{modelo}:generateContent y GET /v1beta/models) para las
// pruebas. Valida la clave (cabecera x-goog-api-key; Google responde 400 y no 401 si no es valida) y responde segun
// una palabra clave que la prueba escribe en la peticion.

import http from "node:http";

export const FAKE_GEMINI_KEY = "AIzaSyClaveFalsaDeGeminiParaPruebas000";

const ANGLES = ["beneficio", "historia", "pregunta", "oferta"];

const googleError = (code, status, message, details) => ({ error: { code, message, status, ...(details ? { details } : {}) } });

export function startFakeGemini(port) {
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
    const apiKey = String(req.headers["x-goog-api-key"] ?? "");
    requests.push({ method: req.method, path: url.pathname, search: url.search, apiKey, body });

    // Como la real: una clave mala (o puesta en la URL en vez de la cabecera) da 400 INVALID_ARGUMENT.
    if (apiKey !== FAKE_GEMINI_KEY) {
      return send(400, googleError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }]));
    }

    if (url.pathname === "/v1beta/models" && req.method === "GET") {
      const models = [
        ["gemini-4-argon", ["generateContent", "countTokens"]],
        ["gemini-3.8-flash", ["generateContent"]],
        ["gemini-3.5-flash-lite", ["generateContent"]],
        ["gemini-embedding-2", ["embedContent"]],
        ["text-embedding-5", ["embedContent"]],
        ["gemini-3.8-flash-image", ["generateContent"]],
        ["imagen-5", ["predict"]],
      ];
      return send(200, { models: models.map(([id, methods]) => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: methods })) });
    }

    const m = url.pathname.match(/^\/v1beta\/models\/([^/:]+):generateContent$/);
    if (!m || req.method !== "POST") return send(404, googleError(404, "NOT_FOUND", `Ruta no soportada: ${url.pathname}`));
    const model = decodeURIComponent(m[1]);
    if (model === "modelo-inexistente") return send(404, googleError(404, "NOT_FOUND", `models/${model} is not found for API version v1beta, or is not supported for generateContent.`));

    const userText = String(body.contents?.at(-1)?.parts?.at(0)?.text ?? "");
    const brief = (userText.match(/"""\n([\s\S]*?)\n"""/) ?? [])[1] ?? "";
    const count = Number((userText.match(/Escribe (\d+) /) ?? [])[1] ?? 1);
    const usage = { promptTokenCount: 950, candidatesTokenCount: 410, thoughtsTokenCount: 190, totalTokenCount: 1550 };
    const reply = (parts, finishReason = "STOP", extra = {}) => ({
      candidates: [{ content: { role: "model", parts }, finishReason, index: 0 }],
      usageMetadata: usage,
      modelVersion: `${model}-001`,
      ...extra,
    });

    if (brief.includes("LIMITE429")) return send(429, googleError(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted (e.g. check quota)."), { "retry-after-ms": "5" });
    if (brief.includes("SATURADO")) return send(503, googleError(503, "UNAVAILABLE", "The model is overloaded. Please try again later."), { "retry-after-ms": "5" });
    if (brief.includes("SEGURIDAD")) return send(200, { candidates: [{ finishReason: "SAFETY", index: 0 }], usageMetadata: usage });
    if (brief.includes("BLOQUEADO")) return send(200, { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 30 } });
    if (brief.includes("CORTADO")) return send(200, reply([{ text: '{"posts":[{"angle":"x"' }], "MAX_TOKENS"));
    if (brief.includes("BASURA")) return send(200, reply([{ text: "Aquí tienes ideas: 1) algo 2) otra cosa" }]));

    const items = Array.from({ length: count }, (_, i) => ({
      angle: ANGLES[i % ANGLES.length],
      text: `Gemini escribió: ${brief.slice(0, 70).trim()} (opción ${i + 1})`,
      hashtags: ["reservi", "#Reservas"],
      image_idea: `Foto ${i + 1} del negocio`,
    }));
    if (brief.includes("VETADA")) items[0].text = "Reserva GRATIS hoy mismo";
    // Un bloque de «pensamiento» antes de la respuesta, como hacen los modelos que razonan.
    return send(200, reply([{ text: "Voy a redactar las opciones...", thought: true }, { text: JSON.stringify({ posts: items }) }]));
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
