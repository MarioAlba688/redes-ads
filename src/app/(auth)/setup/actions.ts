"use server";

import { timingSafeEqual } from "node:crypto";
import { redirect } from "next/navigation";
import * as z from "zod";
import { audit } from "@/lib/audit";
import { createSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { env, isProduction } from "@/lib/env";
import { formValues, type FormState } from "@/lib/form-state";
import { hashPassword, passwordSchema } from "@/lib/password";
import { emailSchema, nameSchema } from "@/lib/validation";

const setupSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ["confirm"],
    error: "Las contraseñas no coinciden.",
  });

function sameToken(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** El primer administrador solo se puede crear mientras no exista ningun usuario. */
export async function setupAdmin(_prev: FormState, formData: FormData): Promise<FormState> {
  const expectedToken = env().SETUP_TOKEN;
  if (isProduction() && !expectedToken) {
    return { error: "Define SETUP_TOKEN en el archivo .env para poder crear el administrador." };
  }

  const values = formValues(formData, ["name", "email"]);

  // El codigo se verifica primero. Si es correcto lo devolvemos en `values` para no
  // pedirlo otra vez cuando falle otra validacion; si es incorrecto, no se repinta.
  if (expectedToken) {
    const setupToken = String(formData.get("setupToken") ?? "");
    if (!sameToken(setupToken, expectedToken)) {
      return {
        fieldErrors: { setupToken: ["El código de instalación no es correcto."] },
        values,
      };
    }
    values.setupToken = setupToken;
  }

  const parsed = setupSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  }
  const { name, email, password } = parsed.data;

  const passwordHash = await hashPassword(password);

  const created = await db.$transaction(async (tx) => {
    if ((await tx.user.count()) > 0) return null;
    return tx.user.create({
      data: { name, email, passwordHash, role: "ADMIN", lastLoginAt: new Date() },
      select: { id: true },
    });
  });

  if (!created) {
    return { error: "La instalación ya se completó. Inicia sesión.", values };
  }

  await createSession(created.id);
  await audit("setup.admin_created", { userId: created.id, target: email });
  redirect("/");
}
