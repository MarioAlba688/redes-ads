// Datos de los motores de IA que pueden usar tanto pantallas de servidor como de cliente (sin servidor ni claves).

export const AI_PROVIDER_IDS = ["anthropic", "openai", "gemini"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export const isAiProviderId = (v: unknown): v is AiProviderId => typeof v === "string" && (AI_PROVIDER_IDS as readonly string[]).includes(v);

export type ProviderInfo = {
  /** Nombre para mostrar. */
  label: string;
  /** Modelo que se propone al configurarlo. Los nombres cambian cada pocos meses: «Cargar modelos» lista los reales de la cuenta. */
  defaultModel: string;
  /** Pagina donde se crea la clave. */
  keyUrl: string;
  keyUrlLabel: string;
  /** Como empieza la clave (solo para orientar; no se usa para validar). */
  keyExample: string;
};

export const PROVIDERS: Record<AiProviderId, ProviderInfo> = {
  anthropic: {
    label: "Claude (Anthropic)",
    defaultModel: "claude-opus-5-5",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyUrlLabel: "console.anthropic.com",
    keyExample: "sk-ant-…",
  },
  openai: {
    label: "GPT (OpenAI)",
    defaultModel: "gpt-6.1-sol",
    keyUrl: "https://platform.openai.com/api-keys",
    keyUrlLabel: "platform.openai.com",
    keyExample: "sk-…",
  },
  gemini: {
    label: "Gemini (Google)",
    defaultModel: "gemini-3.8-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    keyUrlLabel: "aistudio.google.com",
    keyExample: "AIza…",
  },
};

/** Un id de modelo es texto sin espacios ni barras raras: va dentro de una URL (Gemini) y de una cabecera. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,118}$/;

/** Una clave de API: sin espacios ni saltos de linea (suele quedar basura al copiar y pegar). */
export const API_KEY_RE = /^[\x21-\x7e]{10,400}$/;

/** Motor disponible para elegir en el editor. */
export type EngineOption = { id: AiProviderId; label: string; model: string };
