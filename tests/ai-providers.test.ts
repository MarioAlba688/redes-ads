import { describe, expect, it } from "vitest";
import { API_KEY_RE, MODEL_ID_RE } from "@/lib/ai/catalog";
import { chooseEngine, defaultEngineId, statusesFromRows, type ProviderRow } from "@/lib/ai/providers-core";

const row = (over: Partial<ProviderRow> & { provider: string }): ProviderRow => ({
  keyHint: "ab12",
  model: "modelo-x",
  enabled: true,
  isDefault: false,
  lastTestAt: null,
  lastTestOk: null,
  lastError: null,
  ...over,
});
const NO_ENV = { anthropicKey: false, anthropicModel: "claude-opus-5-5" };
const ENV_KEY = { anthropicKey: true, anthropicModel: "claude-opus-5-5" };

describe("statusesFromRows", () => {
  it("siempre devuelve los tres motores, en orden, aunque no haya nada guardado", () => {
    const s = statusesFromRows([], NO_ENV);
    expect(s.map((x) => x.id)).toEqual(["anthropic", "openai", "gemini"]);
    expect(s.every((x) => !x.hasKey && !x.ready && x.source === null)).toBe(true);
    // Modelos propuestos al configurarlos.
    expect(s.map((x) => x.model)).toEqual(["claude-opus-5-5", "gpt-6.1-sol", "gemini-3.8-flash"]);
  });

  it("un motor esta listo si tiene clave guardada y esta activo", () => {
    const s = statusesFromRows([row({ provider: "openai", model: "gpt-x" }), row({ provider: "gemini", enabled: false })], NO_ENV);
    const by = Object.fromEntries(s.map((x) => [x.id, x]));
    expect(by.openai).toMatchObject({ ready: true, source: "db", model: "gpt-x", keyHint: "ab12" });
    expect(by.gemini).toMatchObject({ hasKey: true, enabled: false, ready: false });
    expect(by.anthropic.ready).toBe(false);
  });

  it("una fila sin clave (se quito) no cuenta como clave guardada", () => {
    const s = statusesFromRows([row({ provider: "openai", keyHint: null })], NO_ENV);
    expect(s.find((x) => x.id === "openai")).toMatchObject({ hasKey: false, ready: false });
  });

  it("la ANTHROPIC_API_KEY del .env sigue valiendo para Claude, con su modelo", () => {
    const s = statusesFromRows([], { anthropicKey: true, anthropicModel: "claude-sonnet-5-5" });
    expect(s[0]).toMatchObject({ id: "anthropic", ready: true, source: "env", model: "claude-sonnet-5-5" });
    expect(s[1].ready).toBe(false); // el .env no da clave de OpenAI ni de Gemini
  });

  it("la clave guardada en la app manda sobre la del .env, y desactivarlo en la app lo apaga", () => {
    const stored = statusesFromRows([row({ provider: "anthropic", model: "claude-x" })], ENV_KEY)[0];
    expect(stored).toMatchObject({ source: "db", model: "claude-x", ready: true });
    const off = statusesFromRows([row({ provider: "anthropic", keyHint: null, enabled: false })], ENV_KEY)[0];
    expect(off).toMatchObject({ source: "env", enabled: false, ready: false });
  });
});

describe("eleccion del motor", () => {
  const ready = (...ids: string[]) => statusesFromRows(ids.map((provider) => row({ provider })), NO_ENV);

  it("sin pedir ninguno usa el marcado por defecto; si no hay, el primero disponible", () => {
    const withDefault = statusesFromRows([row({ provider: "anthropic" }), row({ provider: "gemini", isDefault: true })], NO_ENV);
    expect(defaultEngineId(withDefault)).toBe("gemini");
    expect(defaultEngineId(ready("openai", "gemini"))).toBe("openai");
    expect(defaultEngineId(ready())).toBeNull();
  });

  it("un motor marcado por defecto que ya no esta listo no se usa", () => {
    const s = statusesFromRows([row({ provider: "anthropic" }), row({ provider: "openai", isDefault: true, enabled: false })], NO_ENV);
    expect(defaultEngineId(s)).toBe("anthropic");
  });

  it("el motor pedido se respeta; uno que ya no esta disponible NO se sustituye en silencio", () => {
    const s = ready("anthropic", "openai");
    expect(chooseEngine(s, "openai")).toMatchObject({ ok: true, status: { id: "openai" } });
    expect(chooseEngine(s, "gemini")).toEqual({ ok: false, reason: "unavailable" });
    expect(chooseEngine(s, "inventado")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("sin motores listos avisa de que no hay ninguno", () => {
    expect(chooseEngine(ready(), null)).toEqual({ ok: false, reason: "none" });
    expect(chooseEngine(ready(), "")).toEqual({ ok: false, reason: "none" });
  });
});

describe("validacion de claves y modelos", () => {
  it("una clave no lleva espacios ni saltos de linea y tiene un largo razonable", () => {
    expect(API_KEY_RE.test("sk-ant-api03-abcdefghijklmnop")).toBe(true);
    expect(API_KEY_RE.test("AIzaSyD-1234567890_abcdefghij")).toBe(true);
    expect(API_KEY_RE.test("corta")).toBe(false);
    expect(API_KEY_RE.test("tiene espacios dentro 12345")).toBe(false);
    expect(API_KEY_RE.test("clave-con-salto\nde-linea-123")).toBe(false);
    expect(API_KEY_RE.test("x".repeat(401))).toBe(false);
  });

  it("un modelo es un nombre simple: sirve para la URL y la cabecera sin riesgo", () => {
    for (const ok of ["claude-opus-5-5", "gpt-6.1-sol", "gemini-3.8-flash", "o5-mini", "ft:gpt-6:mi-empresa"]) expect(MODEL_ID_RE.test(ok)).toBe(true);
    for (const bad of ["", "a", "con espacio", "../otra", "x/y", "modelo?clave=1", "m\nx", "-empieza-con-guion", "x".repeat(130)]) expect(MODEL_ID_RE.test(bad)).toBe(false);
  });
});
