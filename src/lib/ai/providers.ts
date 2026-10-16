import "server-only";
import type { AiProviderId } from "@/lib/ai/catalog";
import { chooseEngine, statusesFromRows, type EngineStatus, type EnvAi } from "@/lib/ai/providers-core";
import { decryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

// Motores de IA guardados en la base de datos (tabla AiProvider). Las claves solo se descifran aqui, en el momento de
// llamar a la API; las pantallas leen unicamente el estado (WITHOUT_KEY), nunca la clave.

const WITHOUT_KEY = { provider: true, keyHint: true, model: true, enabled: true, isDefault: true, lastTestAt: true, lastTestOk: true, lastError: true } as const;

export function envAi(): EnvAi {
  const e = env();
  return { anthropicKey: !!e.ANTHROPIC_API_KEY, anthropicModel: e.AI_MODEL };
}

/** Estado de cada motor para mostrar en pantalla (sin claves). */
export async function loadEngineStatuses(): Promise<EngineStatus[]> {
  const rows = await db.aiProvider.findMany({ select: WITHOUT_KEY });
  return statusesFromRows(rows, envAi());
}

export type Runtime = { provider: AiProviderId; label: string; apiKey: string; model: string; effort: "low" | "medium" | "high" };

export type Resolution =
  | { ok: true; runtime: Runtime; statuses: EngineStatus[] }
  | { ok: false; reason: "none" | "unavailable" | "unreadable"; statuses: EngineStatus[] };

/** La clave en claro de un proveedor (la guardada en la app o, para Claude, la del .env). Solo para llamar a la API. */
export async function keyFor(provider: AiProviderId): Promise<string | null> {
  const row = await db.aiProvider.findUnique({ where: { provider }, select: { apiKeyEnc: true } });
  if (row?.apiKeyEnc) {
    try {
      return decryptSecret(row.apiKeyEnc);
    } catch {
      return null; // ENCRYPTION_KEY distinta a la que cifro la clave
    }
  }
  return provider === "anthropic" ? (env().ANTHROPIC_API_KEY ?? null) : null;
}

/**
 * Decide con que motor generar (el pedido, o el de por defecto) y devuelve su clave ya descifrada. Una sola consulta:
 * la base esta lejos y cada ida y vuelta cuesta.
 */
export async function resolveRuntime(requested?: string | null): Promise<Resolution> {
  const rows = await db.aiProvider.findMany({ select: { ...WITHOUT_KEY, apiKeyEnc: true } });
  const statuses = statusesFromRows(rows, envAi());
  const choice = chooseEngine(statuses, requested);
  if (!choice.ok) return { ok: false, reason: choice.reason, statuses };

  const { status } = choice;
  const stored = rows.find((r) => r.provider === status.id)?.apiKeyEnc;
  let apiKey: string | null = null;
  if (status.source === "db" && stored) {
    try {
      apiKey = decryptSecret(stored);
    } catch {
      return { ok: false, reason: "unreadable", statuses };
    }
  } else if (status.source === "env") {
    apiKey = env().ANTHROPIC_API_KEY ?? null;
  }
  if (!apiKey) return { ok: false, reason: "unreadable", statuses };

  return { ok: true, statuses, runtime: { provider: status.id, label: status.label, apiKey, model: status.model, effort: env().AI_EFFORT } };
}
