"use server";

import { revalidatePath } from "next/cache";
import * as z from "zod";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { AI_PROVIDER_IDS, API_KEY_RE, MODEL_ID_RE, PROVIDERS, type AiProviderId } from "@/lib/ai/catalog";
import { engineFor } from "@/lib/ai/engines";
import { redactKey } from "@/lib/ai/engines/types";
import { buildUserPrompt } from "@/lib/ai/prompts";
import { keyFor, loadEngineStatuses } from "@/lib/ai/providers";
import { aiOutputSchema } from "@/lib/ai/types";
import { encryptSecret } from "@/lib/crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import type { FormState } from "@/lib/form-state";

// Todas las acciones son del administrador (ai.manage) y re-verifican el permiso aqui: ocultar el menu no protege nada.
// La clave solo viaja del formulario al servidor y se guarda cifrada; ninguna respuesta la devuelve.

/** Resultado que muestra cada tarjeta de motor. */
export type EngineResult = { ok: boolean; message: string; models?: string[] };

const providerSchema = z.enum(AI_PROVIDER_IDS, { error: "Motor desconocido." });
const modelSchema = z.string().trim().regex(MODEL_ID_RE, { error: "El nombre del modelo no es válido (letras, números, puntos y guiones; sin espacios)." });
const keySchema = z.string().trim().regex(API_KEY_RE, { error: "La clave no parece válida: tiene espacios o saltos de línea, o es demasiado corta. Cópiala de nuevo completa." });

const fail = (message: string): EngineResult => ({ ok: false, message });
const checked = (formData: FormData, name: string) => formData.get(name) === "on";

/** Clave escrita en el formulario (si la hay); si esta mal escrita devuelve el error. */
function typedKey(formData: FormData): { key: string | null; error?: string } {
  const raw = String(formData.get("apiKey") ?? "").trim();
  if (!raw) return { key: null };
  const parsed = keySchema.safeParse(raw);
  return parsed.success ? { key: parsed.data } : { key: null, error: parsed.error.issues[0]?.message };
}

export async function saveEngine(formData: FormData): Promise<EngineResult> {
  const auth = await authorize("ai.manage");
  if (!auth.ok) return fail(auth.error);

  const provider = providerSchema.safeParse(formData.get("provider"));
  if (!provider.success) return fail(provider.error.issues[0]?.message ?? "Motor desconocido.");
  const model = modelSchema.safeParse(formData.get("model"));
  if (!model.success) return fail(model.error.issues[0]?.message ?? "Modelo no válido.");
  const typed = typedKey(formData);
  if (typed.error) return fail(typed.error);

  const id = provider.data;
  const label = PROVIDERS[id].label;
  const enabled = checked(formData, "enabled");
  const existing = await db.aiProvider.findUnique({ where: { provider: id }, select: { keyHint: true, model: true } });
  const hasKey = !!typed.key || !!existing?.keyHint || (id === "anthropic" && !!env().ANTHROPIC_API_KEY);
  if (enabled && !hasKey) return fail(`Pega la clave de ${label} para poder activarlo.`);

  const keyChanged = !!typed.key;
  const modelChanged = existing?.model !== model.data;
  // Una prueba anterior ya no vale si cambio la clave o el modelo.
  const resetTest = keyChanged || modelChanged ? { lastTestAt: null, lastTestOk: null, lastError: null } : {};
  const keyData = typed.key ? { apiKeyEnc: encryptSecret(typed.key), keyHint: typed.key.slice(-4) } : {};

  await db.aiProvider.upsert({
    where: { provider: id },
    create: { provider: id, model: model.data, enabled, updatedById: auth.user.id, ...keyData },
    update: { model: model.data, enabled, updatedById: auth.user.id, ...keyData, ...resetTest },
  });
  await audit("ai.engine_saved", { userId: auth.user.id, target: id, detail: { keyChanged, model: model.data, enabled } });
  revalidatePath("/ia");
  return { ok: true, message: keyChanged ? "Guardado. La clave quedó cifrada y no se volverá a mostrar." : "Guardado." };
}

export async function removeEngineKey(formData: FormData): Promise<EngineResult> {
  const auth = await authorize("ai.manage");
  if (!auth.ok) return fail(auth.error);
  const provider = providerSchema.safeParse(formData.get("provider"));
  if (!provider.success) return fail("Motor desconocido.");

  const id = provider.data;
  await db.aiProvider.updateMany({
    where: { provider: id },
    data: { apiKeyEnc: null, keyHint: null, enabled: false, isDefault: false, lastTestAt: null, lastTestOk: null, lastError: null, updatedById: auth.user.id },
  });
  await audit("ai.engine_key_removed", { userId: auth.user.id, target: id });
  revalidatePath("/ia");
  const envNote = id === "anthropic" && env().ANTHROPIC_API_KEY ? " Se seguirá usando la clave del archivo .env mientras exista." : "";
  return { ok: true, message: `Clave eliminada.${envNote}` };
}

/** Elige el motor que se propone primero en el editor ("" = el primero disponible). */
export async function setDefaultEngine(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("ai.manage");
  if (!auth.ok) return { error: auth.error };
  const raw = String(formData.get("provider") ?? "");

  if (raw === "") {
    await db.aiProvider.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  } else {
    const provider = providerSchema.safeParse(raw);
    if (!provider.success) return { error: "Motor desconocido." };
    const status = (await loadEngineStatuses()).find((s) => s.id === provider.data);
    if (!status?.ready) return { error: "Ese motor no está listo: añade su clave y actívalo primero." };
    // Si el motor solo tiene la clave del .env todavia no hay fila donde marcarlo.
    await db.aiProvider.upsert({
      where: { provider: provider.data },
      create: { provider: provider.data, model: status.model, enabled: true, isDefault: true, updatedById: auth.user.id },
      update: { isDefault: true },
    });
    await db.aiProvider.updateMany({ where: { provider: { not: provider.data }, isDefault: true }, data: { isDefault: false } });
  }
  await audit("ai.default_engine_set", { userId: auth.user.id, target: raw || "automatico" });
  revalidatePath("/ia");
  return { success: "Guardado." };
}

/** Clave y modelo con los que probar: lo escrito en el formulario o, si esta vacio, lo guardado. */
async function credentialsFor(formData: FormData, id: AiProviderId): Promise<{ key: string; model: string } | EngineResult> {
  const typed = typedKey(formData);
  if (typed.error) return fail(typed.error);
  const key = typed.key ?? (await keyFor(id));
  if (!key) return fail(`Falta la clave de ${PROVIDERS[id].label}: pégala en el campo «Clave de API».`);
  const model = modelSchema.safeParse(formData.get("model"));
  if (!model.success) return fail(model.error.issues[0]?.message ?? "Modelo no válido.");
  return { key, model: model.data };
}

const isFailure = (v: { key: string; model: string } | EngineResult): v is EngineResult => "ok" in v;

/** Hace una generacion minima para comprobar que la clave y el modelo funcionan. */
export async function testEngine(formData: FormData): Promise<EngineResult> {
  const auth = await authorize("ai.manage");
  if (!auth.ok) return fail(auth.error);
  const provider = providerSchema.safeParse(formData.get("provider"));
  if (!provider.success) return fail("Motor desconocido.");
  const id = provider.data;
  const creds = await credentialsFor(formData, id);
  if (isFailure(creds)) return creds;

  const started = Date.now();
  const run = await engineFor(id).run({
    apiKey: creds.key,
    model: creds.model,
    system: "Redactas publicaciones cortas para redes sociales. Responde solo con el JSON pedido.",
    user: buildUserPrompt({ brief: "Prueba de conexión: escribe una publicación de una sola frase que salude.", count: 1 }),
    maxTokens: 4000,
    effort: "low",
  });
  const ms = Date.now() - started;

  let result: EngineResult;
  if (!run.ok) {
    result = fail(run.error);
  } else {
    let shaped = false;
    try {
      shaped = aiOutputSchema.safeParse(JSON.parse(run.text)).success;
    } catch {
      shaped = false;
    }
    result = shaped
      ? { ok: true, message: `Conexión correcta: ${run.model} respondió en ${(ms / 1000).toFixed(1)} s.` }
      : fail(`La clave funciona, pero «${run.model}» no respondió en el formato esperado. Prueba con otro modelo.`);
  }

  // El resultado se guarda solo si se probo la configuracion guardada (no una clave recien escrita que aun no se guardo).
  if (!typedKey(formData).key) {
    await db.aiProvider.updateMany({
      where: { provider: id },
      data: { lastTestAt: new Date(), lastTestOk: result.ok, lastError: result.ok ? null : redactKey(result.message, creds.key).slice(0, 300) },
    });
  }
  await audit("ai.engine_tested", { userId: auth.user.id, target: id, detail: { ok: result.ok, ms } });
  revalidatePath("/ia");
  return result;
}

/** Pregunta a la API que modelos de texto ve esta clave (los nombres cambian cada pocos meses). */
export async function loadModels(formData: FormData): Promise<EngineResult> {
  const auth = await authorize("ai.manage");
  if (!auth.ok) return fail(auth.error);
  const provider = providerSchema.safeParse(formData.get("provider"));
  if (!provider.success) return fail("Motor desconocido.");
  const id = provider.data;

  const typed = typedKey(formData);
  if (typed.error) return fail(typed.error);
  const key = typed.key ?? (await keyFor(id));
  if (!key) return fail(`Falta la clave de ${PROVIDERS[id].label}: pégala en el campo «Clave de API».`);

  const list = await engineFor(id).listModels(key);
  if (!list.ok) return fail(list.error);
  if (list.models.length === 0) return fail("La clave es válida, pero no devolvió modelos de texto. Escribe el nombre a mano.");
  return { ok: true, message: `${list.models.length} modelos disponibles: elige uno en el campo «Modelo».`, models: list.models.slice(0, 200) };
}
