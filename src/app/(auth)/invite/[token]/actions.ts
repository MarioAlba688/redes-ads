"use server";

import { redirect } from "next/navigation";
import * as z from "zod";
import { audit } from "@/lib/audit";
import { createSession } from "@/lib/auth/session";
import { sha256Hex } from "@/lib/crypto";
import { db } from "@/lib/db";
import { formValues, type FormState } from "@/lib/form-state";
import { hashPassword, passwordSchema } from "@/lib/password";
import { nameSchema } from "@/lib/validation";

const acceptSchema = z
  .object({
    token: z.string().min(10).max(200),
    name: nameSchema,
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    error: "Las contraseñas no coinciden.",
  });

const INVALID = "Esta invitación no es válida o ya venció. Pide una nueva al administrador.";

export async function acceptInvitation(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = formValues(formData, ["name"]);
  const parsed = acceptSchema.safeParse({
    token: formData.get("token"),
    name: formData.get("name"),
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  }
  const { token, name, password } = parsed.data;
  const tokenHash = sha256Hex(token);
  const passwordHash = await hashPassword(password);

  type Outcome = { userId: string; email: string } | { error: string };

  const outcome: Outcome = await db.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({ where: { tokenHash } });
    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
      return { error: INVALID };
    }
    if (await tx.user.findUnique({ where: { email: invitation.email }, select: { id: true } })) {
      return { error: "Ya existe una cuenta con ese correo. Inicia sesión." };
    }

    // Marcamos la invitacion como usada solo si sigue libre: evita que dos
    // envios simultaneos del mismo link creen dos cuentas.
    const claimed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count !== 1) return { error: INVALID };

    const user = await tx.user.create({
      data: {
        email: invitation.email,
        name,
        passwordHash,
        role: invitation.role,
        lastLoginAt: new Date(),
      },
      select: { id: true, email: true },
    });
    return { userId: user.id, email: user.email };
  });

  if ("error" in outcome) return { error: outcome.error, values };

  await createSession(outcome.userId);
  await audit("team.invitation_accepted", { userId: outcome.userId, target: outcome.email });
  redirect("/");
}
