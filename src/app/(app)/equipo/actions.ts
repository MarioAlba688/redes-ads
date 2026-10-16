"use server";

import { revalidatePath } from "next/cache";
import * as z from "zod";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { generateToken, sha256Hex } from "@/lib/crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { formValues, type FormState } from "@/lib/form-state";
import { ROLES } from "@/lib/permissions";
import { emailSchema } from "@/lib/validation";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(ROLES, { error: "Elige un rol." }),
});

export async function createInvitation(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("team.manage");
  if (!auth.ok) return { error: auth.error };

  const values = formValues(formData, ["email", "role"]);
  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  }
  const { email, role } = parsed.data;

  if (await db.user.findUnique({ where: { email }, select: { id: true } })) {
    return { fieldErrors: { email: ["Ya hay una cuenta con ese correo."] }, values };
  }

  const token = generateToken();
  await db.$transaction([
    // Una sola invitacion pendiente por correo: la nueva reemplaza a la anterior.
    db.invitation.deleteMany({ where: { email, acceptedAt: null } }),
    db.invitation.create({
      data: {
        email,
        role,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedById: auth.user.id,
      },
    }),
  ]);

  await audit("team.invited", { userId: auth.user.id, target: email, detail: { role } });
  revalidatePath("/equipo");

  return {
    success: "Invitación creada. Copia el link y envíaselo a la persona.",
    inviteLink: `${env().APP_URL.replace(/\/$/, "")}/invite/${token}`,
  };
}

export async function revokeInvitation(formData: FormData) {
  const auth = await authorize("team.manage");
  if (!auth.ok) return;

  const id = z.string().min(1).safeParse(formData.get("id"));
  if (!id.success) return;

  const invitation = await db.invitation.findFirst({
    where: { id: id.data, acceptedAt: null },
    select: { id: true, email: true },
  });
  if (!invitation) return;

  await db.invitation.delete({ where: { id: invitation.id } });
  await audit("team.invitation_revoked", { userId: auth.user.id, target: invitation.email });
  revalidatePath("/equipo");
}

const roleSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(ROLES, { error: "Rol no válido." }),
});

export async function changeRole(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("team.manage");
  if (!auth.ok) return { error: auth.error };

  const parsed = roleSchema.safeParse({
    userId: formData.get("userId"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { error: "Datos no válidos." };
  const { userId, role } = parsed.data;

  // Nadie cambia su propio rol: asi siempre queda al menos un administrador activo
  // (quien ejecuta esta accion es admin y no es el objetivo).
  if (userId === auth.user.id) return { error: "No puedes cambiar tu propio rol." };

  const target = await db.user.findUnique({ where: { id: userId }, select: { email: true, role: true } });
  if (!target) return { error: "Esa persona ya no existe." };
  if (target.role === role) return undefined;

  await db.user.update({ where: { id: userId }, data: { role } });
  await audit("team.role_changed", {
    userId: auth.user.id,
    target: target.email,
    detail: { from: target.role, to: role },
  });
  revalidatePath("/equipo");
  return { success: "Rol actualizado." };
}

const activeSchema = z.object({
  userId: z.string().min(1),
  active: z.enum(["true", "false"]).transform((v) => v === "true"),
});

export async function setUserActive(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("team.manage");
  if (!auth.ok) return { error: auth.error };

  const parsed = activeSchema.safeParse({
    userId: formData.get("userId"),
    active: formData.get("active"),
  });
  if (!parsed.success) return { error: "Datos no válidos." };
  const { userId, active } = parsed.data;

  if (userId === auth.user.id) return { error: "No puedes desactivar tu propia cuenta." };

  const target = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!target) return { error: "Esa persona ya no existe." };

  // Al desactivar, cerramos sus sesiones abiertas para que pierda el acceso ya.
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { active } }),
    ...(active ? [] : [db.session.deleteMany({ where: { userId } })]),
  ]);
  await audit(active ? "team.user_activated" : "team.user_deactivated", {
    userId: auth.user.id,
    target: target.email,
  });
  revalidatePath("/equipo");
  return undefined;
}
