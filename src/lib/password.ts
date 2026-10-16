import "server-only";
import bcrypt from "bcryptjs";
import { z } from "zod";

const COST = 12;

/** bcrypt solo usa los primeros 72 bytes, por eso ese es el maximo. */
export const passwordSchema = z
  .string()
  .min(10, { error: "La contraseña debe tener al menos 10 caracteres." })
  .refine((v) => new TextEncoder().encode(v).length <= 72, {
    error: "La contraseña es demasiado larga (máximo 72 bytes).",
  })
  .refine((v) => /\p{L}/u.test(v) && /\d/.test(v), {
    error: "Debe incluir al menos una letra y un número.",
  });

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

let dummyHash: Promise<string> | undefined;

/**
 * Hash de relleno para comparar cuando el correo no existe, asi el login tarda
 * lo mismo exista o no la cuenta (evita descubrir correos por tiempo de respuesta).
 */
export function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash("relleno-sin-uso-1", COST);
  return dummyHash;
}
