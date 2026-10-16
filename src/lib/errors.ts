import "server-only";
import { Prisma } from "@/generated/prisma/client";

/** Ultimas lineas de un mensaje largo: en los errores de Prisma la causa va al final, tras la consulta. */
function tail(message: string): string {
  return message
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ")
    .slice(-300);
}

/**
 * Resumen de un error interno para el historial y los registros: el codigo y la causa, sin la
 * consulta completa (que incluye los datos enviados). Nunca incluye tokens.
 */
export function describeInternalError(e: unknown): Record<string, string | number> {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const column = e.meta?.column_name ?? e.meta?.target ?? e.meta?.modelName;
    return {
      prisma: e.code,
      ...(column ? { en: String(column) } : {}),
      causa: tail(e.message),
    };
  }
  if (e instanceof Prisma.PrismaClientValidationError) return { prisma: "validacion", causa: tail(e.message) };
  if (e instanceof Error) return { error: e.name, causa: tail(e.message) };
  return { error: "desconocido" };
}
