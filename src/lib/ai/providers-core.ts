import { AI_PROVIDER_IDS, isAiProviderId, PROVIDERS, type AiProviderId } from "@/lib/ai/catalog";

// Logica pura (sin base de datos) para decidir que motores hay y cual usar. La parte con base de datos esta en providers.ts.

/** Lo que se guarda de cada motor, sin la clave (ni cifrada). */
export type ProviderRow = {
  provider: string;
  keyHint: string | null;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastError: string | null;
};

export type EngineStatus = {
  id: AiProviderId;
  label: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  hasKey: boolean;
  /** De donde sale la clave: la que puso un administrador en la app, o ANTHROPIC_API_KEY del .env. */
  source: "db" | "env" | null;
  keyHint: string | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  /** Se puede usar ahora: tiene clave y esta activo. */
  ready: boolean;
};

export type EnvAi = { anthropicKey: boolean; anthropicModel: string };

/** Un estado por proveedor, haya o no fila guardada. La clave de Claude del .env sigue valiendo como respaldo. */
export function statusesFromRows(rows: readonly ProviderRow[], env: EnvAi): EngineStatus[] {
  return AI_PROVIDER_IDS.map((id) => {
    const row = rows.find((r) => r.provider === id);
    const dbKey = !!row?.keyHint;
    const envKey = id === "anthropic" && env.anthropicKey;
    const hasKey = dbKey || envKey;
    const enabled = row ? row.enabled : true;
    return {
      id,
      label: PROVIDERS[id].label,
      model: row?.model || (id === "anthropic" ? env.anthropicModel : PROVIDERS[id].defaultModel),
      enabled,
      isDefault: row?.isDefault ?? false,
      hasKey,
      source: dbKey ? "db" : envKey ? "env" : null,
      keyHint: row?.keyHint ?? null,
      lastTestAt: row?.lastTestAt ?? null,
      lastTestOk: row?.lastTestOk ?? null,
      lastError: row?.lastError ?? null,
      ready: hasKey && enabled,
    };
  });
}

/** El motor que se propone primero: el marcado por defecto si se puede usar; si no, el primero disponible. */
export function defaultEngineId(statuses: readonly EngineStatus[]): AiProviderId | null {
  const ready = statuses.filter((s) => s.ready);
  return (ready.find((s) => s.isDefault) ?? ready[0])?.id ?? null;
}

export type Choice = { ok: true; status: EngineStatus } | { ok: false; reason: "none" | "unavailable" };

/** Elige el motor pedido (si no se pide ninguno, el de por defecto). Un motor pedido que ya no esta disponible no se sustituye en silencio. */
export function chooseEngine(statuses: readonly EngineStatus[], requested?: string | null): Choice {
  if (requested) {
    const found = isAiProviderId(requested) ? statuses.find((s) => s.id === requested && s.ready) : undefined;
    return found ? { ok: true, status: found } : { ok: false, reason: "unavailable" };
  }
  const id = defaultEngineId(statuses);
  const status = statuses.find((s) => s.id === id);
  return status ? { ok: true, status } : { ok: false, reason: "none" };
}
