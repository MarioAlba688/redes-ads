"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as z from "zod";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { AI_PROVIDER_IDS } from "@/lib/ai/catalog";
import { POST_PLATFORMS } from "@/lib/ai/limits";
import { generateForUser } from "@/lib/ai/service";
import type { AiActionState } from "@/lib/ai/types";
import { db } from "@/lib/db";
import { formValues, type FormState } from "@/lib/form-state";
import { deleteImage } from "@/lib/media";
import { lengthError, postSchema } from "@/lib/post-validation";
import { PUBLISHABLE_KINDS } from "@/lib/posts";

// ---------------------------------------------------------------------------
// Generar texto con IA
// ---------------------------------------------------------------------------

const generateSchema = z.object({
  brandId: z.string().min(1),
  brief: z
    .string()
    .trim()
    .min(10, { error: "Cuéntale a la IA sobre qué es la publicación (al menos 10 caracteres)." })
    .max(2000, { error: "La petición es demasiado larga (máximo 2000 caracteres)." }),
  count: z.coerce.number().int().min(1).max(4),
  platform: z.enum(POST_PLATFORMS),
});

// Motor de IA elegido (Claude, GPT, Gemini). Vacio = el de por defecto; el servidor comprueba que siga disponible.
const providerField = z.enum(AI_PROVIDER_IDS).or(z.literal(""));

export async function generateAction(_prev: AiActionState, formData: FormData): Promise<AiActionState> {
  const auth = await authorize("content.create");
  if (!auth.ok) return { error: auth.error };

  const values = {
    brief: String(formData.get("brief") ?? ""),
    count: String(formData.get("count") ?? "3"),
    platform: String(formData.get("platform") ?? "both"),
    provider: String(formData.get("provider") ?? ""),
  };
  const parsed = generateSchema.safeParse({ brandId: formData.get("brandId"), ...values });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Datos no válidos.", values };
  const provider = providerField.safeParse(values.provider);
  if (!provider.success) return { error: "Motor de IA no válido.", values };

  const brand = await db.brand.findUnique({ where: { id: parsed.data.brandId } });
  if (!brand) return { error: "Esa marca ya no existe.", values };

  const result = await generateForUser({
    userId: auth.user.id,
    brandId: brand.id,
    brand,
    brief: parsed.data.brief,
    count: parsed.data.count,
    platform: parsed.data.platform,
    provider: provider.data || null,
  });

  await audit("ai.generated", {
    userId: auth.user.id,
    target: brand.name,
    detail: result.ok
      ? { ok: true, engine: result.engine?.label, options: result.posts.length, discarded: result.discarded, in: result.inputTokens, out: result.outputTokens }
      : { ok: false, engine: result.engine?.label, error: result.error.slice(0, 200) },
  });

  if (!result.ok) return { error: result.error, usage: { used: result.usage.used, limit: result.usage.limit }, values };
  return {
    posts: result.posts,
    discarded: result.discarded,
    usage: { used: result.usage.used, limit: result.usage.limit },
    engine: result.engine,
    values,
  };
}

// ---------------------------------------------------------------------------
// Borradores
// ---------------------------------------------------------------------------

/** Valida los destinos elegidos: deben ser cuentas de esa marca donde se pueda publicar y que sigan conectadas. */
async function resolveTargets(brandId: string, targetIds: string[]) {
  if (targetIds.length === 0) return { ok: true as const, kinds: [] as string[] };
  const accounts = await db.socialAccount.findMany({
    where: { id: { in: targetIds } },
    select: { id: true, name: true, kind: true, brandId: true, status: true },
  });
  if (accounts.length !== targetIds.length) return { ok: false as const, error: "Alguno de los destinos ya no existe." };
  const bad = accounts.find(
    (a) => a.brandId !== brandId || a.status === "REVOKED" || !(PUBLISHABLE_KINDS as readonly string[]).includes(a.kind),
  );
  if (bad) return { ok: false as const, error: `«${bad.name}» no es un destino válido para esta marca.` };
  return { ok: true as const, kinds: accounts.map((a) => a.kind) };
}

function parsePostForm(formData: FormData) {
  const targetIds = [...new Set(formData.getAll("targetId").map(String))];
  const values = { ...formValues(formData, ["linkUrl"]), targetIds: targetIds.join(",") };
  const parsed = postSchema.safeParse(Object.fromEntries(formData.entries()));
  return { targetIds, values, parsed };
}

export async function createDraft(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("content.create");
  if (!auth.ok) return { error: auth.error };

  const { targetIds, values, parsed } = parsePostForm(formData);
  if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  const data = parsed.data;

  if (!(await db.brand.findUnique({ where: { id: data.brandId }, select: { id: true } }))) {
    return { error: "Esa marca ya no existe.", values };
  }
  const targets = await resolveTargets(data.brandId, targetIds);
  if (!targets.ok) return { error: targets.error, values };
  const tooLong = lengthError(data.text, targets.kinds);
  if (tooLong) return { fieldErrors: { text: [tooLong] }, values };

  const post = await db.post.create({
    data: {
      brandId: data.brandId,
      text: data.text,
      linkUrl: data.linkUrl,
      aiGenerated: data.aiGenerated,
      aiBrief: data.aiGenerated ? data.aiBrief : null,
      createdById: auth.user.id,
      targets: { create: targetIds.map((accountId) => ({ accountId })) },
    },
    select: { id: true },
  });
  await audit("post.created", { userId: auth.user.id, target: post.id, detail: { ai: data.aiGenerated, targets: targetIds.length } });
  revalidatePath("/publicaciones");
  redirect(`/publicaciones/${post.id}?guardada=1`);
}

export async function updateDraft(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("content.create");
  if (!auth.ok) return { error: auth.error };

  const id = z.string().min(1).safeParse(formData.get("id"));
  if (!id.success) return { error: "Datos no válidos." };
  const { targetIds, values, parsed } = parsePostForm(formData);
  if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  const data = parsed.data;

  const existing = await db.post.findUnique({ where: { id: id.data }, select: { status: true, brandId: true } });
  if (!existing) return { error: "Esa publicación ya no existe.", values };
  if (existing.status !== "DRAFT") return { error: "Solo se puede editar un borrador.", values };
  if (existing.brandId !== data.brandId) return { error: "No se puede cambiar la marca de una publicación.", values };

  const targets = await resolveTargets(existing.brandId, targetIds);
  if (!targets.ok) return { error: targets.error, values };
  const tooLong = lengthError(data.text, targets.kinds);
  if (tooLong) return { fieldErrors: { text: [tooLong] }, values };

  await db.$transaction(
    async (tx) => {
      await tx.post.update({
        where: { id: id.data },
        data: {
          text: data.text,
          linkUrl: data.linkUrl,
          aiGenerated: data.aiGenerated,
          aiBrief: data.aiGenerated ? data.aiBrief : null,
        },
      });
      await tx.postTarget.deleteMany({ where: { postId: id.data, accountId: { notIn: targetIds } } });
      const current = await tx.postTarget.findMany({ where: { postId: id.data }, select: { accountId: true } });
      const have = new Set(current.map((t) => t.accountId));
      const toAdd = targetIds.filter((a) => !have.has(a));
      if (toAdd.length > 0) await tx.postTarget.createMany({ data: toAdd.map((accountId) => ({ postId: id.data, accountId })) });
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

  await audit("post.updated", { userId: auth.user.id, target: id.data });
  revalidatePath("/publicaciones");
  revalidatePath(`/publicaciones/${id.data}`);
  return { success: "Borrador guardado." };
}

/** Quita la imagen de un borrador (borra la fila y el archivo). */
export async function removeMedia(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("content.create");
  if (!auth.ok) return { error: auth.error };

  const id = z.string().min(1).safeParse(formData.get("mediaId"));
  if (!id.success) return { error: "Datos no válidos." };

  const media = await db.postMedia.findUnique({
    where: { id: id.data },
    select: { storageKey: true, postId: true, post: { select: { status: true } } },
  });
  if (!media) return { error: "Esa imagen ya no existe." };
  if (media.post.status !== "DRAFT") return { error: "Solo se pueden cambiar las imágenes de un borrador." };

  await db.postMedia.delete({ where: { id: id.data } });
  await deleteImage(media.storageKey);
  await audit("post.media_removed", { userId: auth.user.id, target: media.postId });
  revalidatePath(`/publicaciones/${media.postId}`);
  return { success: "Imagen quitada." };
}

/** Cambia el orden de las imagenes de un borrador: mueve una antes o despues de su vecina. La primera es la portada. */
export async function moveMedia(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("content.create");
  if (!auth.ok) return { error: auth.error };

  const parsed = z.object({ mediaId: z.string().min(1), direction: z.enum(["before", "after"]) }).safeParse({
    mediaId: formData.get("mediaId"),
    direction: formData.get("direction"),
  });
  if (!parsed.success) return { error: "Datos no válidos." };

  const media = await db.postMedia.findUnique({ where: { id: parsed.data.mediaId }, select: { postId: true, post: { select: { status: true } } } });
  if (!media) return { error: "Esa imagen ya no existe." };
  if (media.post.status !== "DRAFT") return { error: "Solo se pueden cambiar las imágenes de un borrador." };

  const all = await db.postMedia.findMany({
    where: { postId: media.postId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, position: true },
  });
  const from = all.findIndex((m) => m.id === parsed.data.mediaId);
  const to = parsed.data.direction === "before" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= all.length) return undefined; // ya esta en el borde: nada que mover

  const order = all.map((m) => m.id);
  [order[from], order[to]] = [order[to], order[from]];
  // Se reasignan posiciones 0..n-1 y solo se escriben las que cambian (normalmente dos).
  const changed = order.flatMap((id, position) => (all.find((m) => m.id === id)?.position === position ? [] : [{ id, position }]));
  await db.$transaction(changed.map((c) => db.postMedia.update({ where: { id: c.id }, data: { position: c.position } })));
  await audit("post.media_moved", { userId: auth.user.id, target: media.postId });
  revalidatePath(`/publicaciones/${media.postId}`);
  return { success: "Orden guardado." };
}

export async function deleteDraft(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("content.create");
  if (!auth.ok) return { error: auth.error };

  const id = z.string().min(1).safeParse(formData.get("id"));
  if (!id.success) return { error: "Datos no válidos." };

  const post = await db.post.findUnique({
    where: { id: id.data },
    select: { status: true, media: { select: { storageKey: true } }, targets: { select: { status: true } } },
  });
  if (!post) return { error: "Esa publicación ya no existe." };
  if (post.status !== "DRAFT" && post.status !== "CANCELLED" && post.status !== "FAILED") {
    return { error: "Solo se puede borrar un borrador, una publicación cancelada o una que falló." };
  }
  // Si alguno de sus destinos ya salio, la publicacion existe en una red social: se conserva el registro.
  if (post.targets.some((t) => t.status === "PUBLISHED")) return { error: "Esta publicación ya salió en una red social, así que no se puede borrar de aquí." };

  await db.post.delete({ where: { id: id.data } }); // sus destinos y sus imagenes (filas) se borran en cascada
  for (const m of post.media) await deleteImage(m.storageKey); // y los archivos, que no los borra la base de datos
  await audit("post.deleted", { userId: auth.user.id, target: id.data });
  revalidatePath("/publicaciones");
  redirect("/publicaciones");
}
