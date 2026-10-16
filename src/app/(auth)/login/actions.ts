"use server";

import { redirect } from "next/navigation";
import * as z from "zod";
import { audit } from "@/lib/audit";
import { createSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { formValues, type FormState } from "@/lib/form-state";
import { getDummyHash, verifyPassword } from "@/lib/password";
import { emailSchema } from "@/lib/validation";

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, { error: "Escribe tu contraseña." }),
});

const GENERIC_ERROR = "Correo o contraseña incorrectos.";

export async function login(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = formValues(formData, ["email"]);
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  }
  const { email, password } = parsed.data;

  const user = await db.user.findUnique({ where: { email } });

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    return {
      error: `Demasiados intentos fallidos. Prueba de nuevo en ${minutes} min.`,
      values,
    };
  }

  // Siempre se compara contra un hash (real o de relleno) para que el tiempo
  // de respuesta no delate si el correo existe.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));

  if (!user || !passwordOk || !user.active) {
    if (user && !passwordOk) {
      const updated = await db.user.update({
        where: { id: user.id },
        data: { failedLogins: { increment: 1 } },
        select: { failedLogins: true },
      });
      if (updated.failedLogins >= MAX_FAILED_LOGINS) {
        await db.user.update({
          where: { id: user.id },
          data: {
            failedLogins: 0,
            lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000),
          },
        });
      }
    }
    await audit("auth.login_failed", { userId: user?.id, target: email });
    return { error: GENERIC_ERROR, values };
  }

  await db.user.update({
    where: { id: user.id },
    data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  await createSession(user.id);
  await audit("auth.login", { userId: user.id });
  redirect("/");
}
