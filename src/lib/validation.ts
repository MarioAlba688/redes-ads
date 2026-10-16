import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Escribe un correo válido." }));

export const nameSchema = z
  .string()
  .trim()
  .min(2, { error: "El nombre debe tener al menos 2 caracteres." })
  .max(80, { error: "El nombre es demasiado largo." });
