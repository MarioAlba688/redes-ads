"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import * as z from "zod";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import type { FormState } from "@/lib/form-state";
import { validatePostForReview } from "@/lib/post-checks";
import { canTransition, scheduleError, type PostAction } from "@/lib/post-workflow";
import type { PostStatusName } from "@/lib/posts";
import { runDuePublications } from "@/lib/publishing/run";
import { zonedTimeToUtc } from "@/lib/time";

// Todas las acciones de una publicacion pasan por aqui: comprueban el permiso, que el estado actual permita la
// accion (lib/post-workflow.ts) y que lo que se va a publicar este completo (lib/post-checks.ts). El cambio de
// estado es una actualizacion condicional, asi que dos personas pulsando a la vez no se pisan.

const ACTION_PERMISSION = {
  submit: "content.create",
  return: "content.approve",
  approve: "content.approve",
  schedule: "content.publish",
  publishNow: "content.publish",
  cancel: "content.publish",
  retry: "content.publish",
} as const satisfies Record<PostAction, "content.create" | "content.approve" | "content.publish">;

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

function load(id: string) {
  return db.post.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      text: true,
      brandId: true,
      brand: { select: { timezone: true } },
      targets: { select: { id: true, status: true, account: { select: { name: true, kind: true, status: true, brandId: true, scopes: true } } } },
      media: { select: { mimeType: true, width: true, height: true }, orderBy: { position: "asc" } },
    },
  });
}

/** Problemas que impiden avanzar (texto, destinos, imagen...), unidos en un mensaje de varias lineas. */
function problems(post: Loaded): string | null {
  const errors = validatePostForReview({
    text: post.text,
    brandId: post.brandId,
    targets: post.targets.map((t) => ({ name: t.account.name, kind: t.account.kind, status: t.account.status, brandId: t.account.brandId, scopes: t.account.scopes })),
    media: post.media,
  });
  return errors.length > 0 ? errors.map((e) => `• ${e}`).join("\n") : null;
}

/** Hora local "2026-10-16T09:00" en la zona de la marca -> instante UTC validado. */
function parseWhen(when: string, timezone: string): { ok: true; at: Date } | { ok: false; error: string } {
  const at = zonedTimeToUtc(when, timezone);
  if (!at) return { ok: false, error: "La fecha u hora no es válida (puede que esa hora no exista por el cambio de horario)." };
  const bad = scheduleError(at);
  return bad ? { ok: false, error: bad } : { ok: true, at };
}

/** Cambia el estado solo si sigue en uno de los estados de origen. Devuelve false si alguien se adelanto. */
async function move(id: string, from: readonly PostStatusName[], data: Parameters<typeof db.post.updateMany>[0]["data"]) {
  const r = await db.post.updateMany({ where: { id, status: { in: [...from] } }, data });
  return r.count === 1;
}

const refresh = (id: string) => {
  revalidatePath("/publicaciones");
  revalidatePath(`/publicaciones/${id}`);
  revalidatePath("/publicaciones/calendario");
  revalidatePath("/");
};

/** Comprobaciones comunes: permiso, publicacion existente y estado que permite la accion. */
async function prepare(action: PostAction, formData: FormData) {
  const auth = await authorize(ACTION_PERMISSION[action]);
  if (!auth.ok) return { error: auth.error } as const;
  const id = z.string().min(1).safeParse(formData.get("id"));
  if (!id.success) return { error: "Datos no válidos." } as const;
  const post = await load(id.data);
  if (!post) return { error: "Esa publicación ya no existe." } as const;
  if (!canTransition(post.status, action)) {
    return { error: "El estado de la publicación cambió y esta acción ya no es posible. Recarga la página." } as const;
  }
  return { user: auth.user, post } as const;
}

const noteSchema = z.string().trim().max(1000, { error: "La nota es demasiado larga (máximo 1000 caracteres)." });

// ---------------------------------------------------------------------------

export async function submitForReview(_prev: FormState, formData: FormData): Promise<FormState> {
  const p = await prepare("submit", formData);
  if ("error" in p) return { error: p.error };
  const issues = problems(p.post);
  if (issues) return { error: `Falta corregir esto antes de enviarla:\n${issues}` };

  const ok = await move(p.post.id, ["DRAFT"], {
    status: "IN_REVIEW",
    submittedAt: new Date(),
    reviewedById: null,
    reviewedAt: null,
    reviewNote: null,
  });
  if (!ok) return { error: "La publicación cambió mientras tanto. Recarga la página." };
  await audit("post.submitted", { userId: p.user.id, target: p.post.id });
  refresh(p.post.id);
  return { success: "Enviada a revisión." };
}

export async function returnPost(_prev: FormState, formData: FormData): Promise<FormState> {
  const p = await prepare("return", formData);
  if ("error" in p) return { error: p.error };
  const note = noteSchema.min(3, { error: "Explica qué hay que cambiar (al menos 3 caracteres)." }).safeParse(formData.get("note"));
  if (!note.success) return { error: note.error.issues[0]?.message ?? "Nota no válida." };

  const ok = await move(p.post.id, ["IN_REVIEW"], { status: "DRAFT", reviewedById: p.user.id, reviewedAt: new Date(), reviewNote: note.data });
  if (!ok) return { error: "La publicación cambió mientras tanto. Recarga la página." };
  await audit("post.returned", { userId: p.user.id, target: p.post.id, detail: { note: note.data.slice(0, 200) } });
  refresh(p.post.id);
  return { success: "Devuelta al editor con tu nota." };
}

export async function approvePost(_prev: FormState, formData: FormData): Promise<FormState> {
  const p = await prepare("approve", formData);
  if ("error" in p) return { error: p.error };
  const note = noteSchema.safeParse(formData.get("note") ?? "");
  if (!note.success) return { error: note.error.issues[0]?.message ?? "Nota no válida." };

  // Se vuelve a comprobar: desde que la enviaron pudo desconectarse una cuenta o cambiar la imagen.
  const issues = problems(p.post);
  if (issues) return { error: `No se puede aprobar todavía:\n${issues}` };

  const when = String(formData.get("when") ?? "").trim();
  let scheduledAt: Date | null = null;
  if (when) {
    const parsed = parseWhen(when, p.post.brand.timezone);
    if (!parsed.ok) return { error: parsed.error };
    scheduledAt = parsed.at;
  }

  const ok = await move(p.post.id, ["IN_REVIEW"], {
    status: scheduledAt ? "SCHEDULED" : "APPROVED",
    scheduledAt,
    reviewedById: p.user.id,
    reviewedAt: new Date(),
    reviewNote: note.data || null,
  });
  if (!ok) return { error: "La publicación cambió mientras tanto. Recarga la página." };
  await audit("post.approved", { userId: p.user.id, target: p.post.id, detail: { scheduledAt: scheduledAt?.toISOString() ?? null } });
  refresh(p.post.id);
  return { success: scheduledAt ? "Aprobada y programada." : "Aprobada. Ahora puedes programarla o publicarla." };
}

export async function schedulePost(_prev: FormState, formData: FormData): Promise<FormState> {
  const p = await prepare("schedule", formData);
  if ("error" in p) return { error: p.error };
  const issues = problems(p.post);
  if (issues) return { error: `No se puede programar todavía:\n${issues}` };

  const when = String(formData.get("when") ?? "").trim();
  if (!when) return { error: "Elige la fecha y la hora." };
  const parsed = parseWhen(when, p.post.brand.timezone);
  if (!parsed.ok) return { error: parsed.error };

  const ok = await move(p.post.id, ["APPROVED", "SCHEDULED"], { status: "SCHEDULED", scheduledAt: parsed.at });
  if (!ok) return { error: "La publicación cambió mientras tanto. Recarga la página." };
  // Si se reprograma una que estaba esperando un reintento, el reintento tambien se adelanta/atrasa con ella.
  await db.postTarget.updateMany({ where: { postId: p.post.id, status: "PENDING" }, data: { nextAttemptAt: null } });
  await audit("post.scheduled", { userId: p.user.id, target: p.post.id, detail: { scheduledAt: parsed.at.toISOString() } });
  refresh(p.post.id);
  return { success: "Programada." };
}

/** La deja programada para ahora y avisa al proceso en segundo plano sin esperar a su siguiente vuelta. */
async function sendNow(id: string, userId: string, from: readonly PostStatusName[], auditAction: string): Promise<FormState> {
  const ok = await move(id, from, { status: "SCHEDULED", scheduledAt: new Date(), publishedAt: null });
  if (!ok) return { error: "La publicación cambió mientras tanto. Recarga la página." };
  await audit(auditAction, { userId, target: id });
  after(async () => {
    await runDuePublications();
  });
  refresh(id);
  return { success: "En camino: se está publicando. Recarga en unos segundos para ver el resultado." };
}

export async function publishNowAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const p = await prepare("publishNow", formData);
  if ("error" in p) return { error: p.error };
  const issues = problems(p.post);
  if (issues) return { error: `No se puede publicar todavía:\n${issues}` };
  await db.postTarget.updateMany({ where: { postId: p.post.id, status: "PENDING" }, data: { nextAttemptAt: null } });
  return sendNow(p.post.id, p.user.id, ["APPROVED", "SCHEDULED"], "post.publish_now");
}

export async function retryPost(_prev: FormState, formData: FormData): Promise<FormState> {
  const p = await prepare("retry", formData);
  if ("error" in p) return { error: p.error };
  const issues = problems(p.post);
  if (issues) return { error: `Antes de reintentar hay que corregir esto:\n${issues}` };

  // Solo se reintentan los destinos que fallaron; los que ya salieron no se tocan (no se publica dos veces).
  await db.postTarget.updateMany({
    where: { postId: p.post.id, status: "FAILED" },
    data: { status: "PENDING", attempts: 0, error: null, nextAttemptAt: null, lockedAt: null },
  });
  return sendNow(p.post.id, p.user.id, ["FAILED", "PARTIAL"], "post.retry");
}

export async function cancelPost(_prev: FormState, formData: FormData): Promise<FormState> {
  const p = await prepare("cancel", formData);
  if ("error" in p) return { error: p.error };
  const ok = await move(p.post.id, ["IN_REVIEW", "APPROVED", "SCHEDULED"], { status: "CANCELLED", scheduledAt: null });
  if (!ok) return { error: "La publicación cambió mientras tanto (quizá ya se está publicando). Recarga la página." };
  await audit("post.cancelled", { userId: p.user.id, target: p.post.id });
  refresh(p.post.id);
  return { success: "Publicación cancelada." };
}
