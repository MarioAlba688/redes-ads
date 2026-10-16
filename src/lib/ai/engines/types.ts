import type { AiProviderId } from "@/lib/ai/catalog";

/** Lo que cada motor necesita para una llamada. Los prompts ya vienen armados (no dependen del proveedor). */
export type EngineParams = {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  effort: "low" | "medium" | "high";
};

/** Resultado de una llamada: nunca se lanza una excepcion, siempre un mensaje en español listo para mostrar. */
export type EngineResult =
  | { ok: true; text: string; model: string; inputTokens: number; outputTokens: number }
  | { ok: false; error: string; inputTokens?: number; outputTokens?: number };

export type Engine = {
  id: AiProviderId;
  /** Pide al modelo que responda con el JSON de las opciones (ver AI_OUTPUT_JSON_SCHEMA). */
  run(params: EngineParams): Promise<EngineResult>;
  /** Modelos de texto que ve esa clave, ordenados (para el desplegable de la pantalla de configuracion). */
  listModels(apiKey: string): Promise<{ ok: true; models: string[] } | { ok: false; error: string }>;
};

/** Quita la clave de cualquier texto antes de mostrarlo o guardarlo (algunas APIs repiten parte de la clave en sus errores). */
export function redactKey(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("••••") : text;
}
