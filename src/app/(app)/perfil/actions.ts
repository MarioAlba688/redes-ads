"use server";

import * as z from "zod";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import type { FormState } from "@/lib/form-state";
import { hashPassword, passwordSchema, verifyPassword } from "@/lib/password";

const changePasswordSchema = z
  .object({
    current: z.string().min(1, { error: "Escribe tu contraseña actual." }),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    error: "Las contraseñas no coinciden.",
  });

export async function changePassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize();
  if (!auth.ok) return { error: auth.error };

  const parsed = changePasswordSchema.safeParse({
    current: formData.get("current"),
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }
  const { current, password } = parsed.data;

  const user = await db.user.findUnique({
    where: { id: auth.user.id },
    select: { passwordHash: true },
  });
  if (!user || !(await verifyPassword(current, user.passwordHash))) {
    return { fieldErrors: { current: ["La contraseña actual no es correcta."] } };
  }

  const passwordHash = await hashPassword(password);
  await db.$transaction([
    db.user.update({ where: { id: auth.user.id }, data: { passwordHash } }),
    // Cierra las demas sesiones (otros dispositivos) y conserva la actual.
    db.session.deleteMany({
      where: { userId: auth.user.id, id: { not: auth.user.sessionId } },
    }),
  ]);
  await audit("auth.password_changed", { userId: auth.user.id });

  return { success: "Contraseña actualizada. Se cerró la sesión en tus otros dispositivos." };
}
