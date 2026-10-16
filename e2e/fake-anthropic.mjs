// Servidor que imita la API de Claude (POST /v1/messages) para las pruebas, sin gastar dinero ni
// necesitar clave real. Valida lo que importa (clave, modelo, salida JSON estructurada, perfil de marca en
// el sistema) y responde segun una palabra clave que la prueba escribe en la peticion.

import http from "node:http";

export const FAKE_API_KEY = "sk-ant-clave-falsa-de-pruebas-0000000000";
// Segunda clave valida: sirve para comprobar cual de dos claves (la del .env o la guardada en la app) se uso.
export const FAKE_API_KEY_2 = "sk-ant-segunda-clave-falsa-0000000000";
const VALID_KEYS = new Set([FAKE_API_KEY, FAKE_API_KEY_2]);

const ANGLES = ["beneficio", "historia", "pregunta", "oferta"];
const OPENERS = ["Descubre", "Imagina", "¿Sabías que", "Hoy"];

function okBody(items, extra = {}) {
  return {
    id: "msg_fake_0001",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify({ posts: items }) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 450, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...extra,
  };
}

const apiError = (type, message) => ({ type: "error", error: { type, message } });

export function startFakeAnthropic(port) {
  const requests = [];
  let sinRespaldoSeen = false;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/v1/models" && req.method === "GET") {
      const key = req.headers["x-api-key"];
      requests.push({ apiKey: key, path: url.pathname, body: null });
      if (!VALID_KEYS.has(key)) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify(apiError("authentication_error", "invalid x-api-key")));
      }
      const data = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map((id) => ({ type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z" }));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id }));
    }
    if (url.pathname !== "/v1/messages" || req.method !== "POST") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify(apiError("not_found_error", `Ruta no soportada: ${url.pathname}`)));
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const entry = {
      path: url.pathname,
      apiKey: req.headers["x-api-key"],
      beta: req.headers["anthropic-beta"] ?? null,
      version: req.headers["anthropic-version"] ?? null,
      body,
    };
    requests.push(entry);

    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };

    if (!VALID_KEYS.has(entry.apiKey)) return send(401, apiError("authentication_error", "invalid x-api-key"));

    const userText = String(body.messages?.at(-1)?.content ?? "");
    const brief = (userText.match(/"""\n([\s\S]*?)\n"""/) ?? [])[1] ?? "";
    const count = Number((userText.match(/Escribe (\d+) /) ?? [])[1] ?? 1);

    // Marcadores que la prueba escribe en la peticion para provocar cada caso.
    if (brief.includes("ERROR401")) return send(401, apiError("authentication_error", "invalid x-api-key"));
    if (brief.includes("LIMITE429")) return send(429, apiError("rate_limit_error", "rate limited"), { "retry-after-ms": "5" });
    if (brief.includes("SATURADO")) return send(529, apiError("overloaded_error", "Overloaded"), { "retry-after-ms": "5" });
    if (brief.includes("SINCREDITO")) return send(400, apiError("invalid_request_error", "Your credit balance is too low to access the Anthropic API."));
    if (brief.includes("SINRESPALDO") && body.fallbacks !== undefined && !sinRespaldoSeen) {
      sinRespaldoSeen = true;
      return send(400, apiError("invalid_request_error", "fallbacks: Extra inputs are not permitted"));
    }
    if (brief.includes("REHUSAR")) {
      return send(200, okBody([], { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms", explanation: "x" } }));
    }
    if (brief.includes("CORTADO")) return send(200, okBody([], { stop_reason: "max_tokens", content: [{ type: "text", text: '{"posts":[{"angle":"x"' }] }));
    if (brief.includes("BASURA")) return send(200, okBody([], { content: [{ type: "text", text: "Lo siento, aquí tienes ideas: 1) algo 2) otra cosa" }] }));

    const items = Array.from({ length: count }, (_, i) => ({
      angle: ANGLES[i % ANGLES.length],
      text: `${OPENERS[i % OPENERS.length]}: ${brief.slice(0, 70).trim()} (opción ${i + 1})`,
      hashtags: ["reservi", "#Reservas", "agenda", "reservi"],
      image_idea: `Foto ${i + 1} del negocio en acción`,
    }));
    if (brief.includes("TODOVETADO")) for (const it of items) it.text = `Todo ${it.angle} GRATIS para ti`;
    // Solo la primera opcion usa la palabra vetada de la marca; las demas no (la peticion en si no la lleva).
    else if (brief.includes("VETADA")) items[0].text = "Reserva GRATIS hoy mismo";
    if (brief.includes("ENLACE")) items[0].text = "Mira todo en https://reservi.example/planes";
    if (brief.includes("LARGO")) items[items.length - 1].text = "x".repeat(2300);
    return send(200, okBody(items));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        close: () => new Promise((r) => server.close(() => r())),
        requests: () => requests,
        reset: () => {
          requests.length = 0;
          sinRespaldoSeen = false;
        },
      }),
    );
  });
}
