import "server-only";
import { headers } from "next/headers";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";

/**
 * IP informativa. Solo es confiable si la app esta detras de un proxy propio.
 * Fuera de una peticion (el proceso en segundo plano) no hay cabeceras: devuelve null.
 */
export async function clientIp(): Promise<string | null> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    return (forwarded || h.get("x-real-ip") || null)?.slice(0, 64) ?? null;
  } catch {
    return null;
  }
}

type AuditInput = {
  userId?: string | null;
  target?: string;
  detail?: Prisma.InputJsonValue;
};

/** Registra quien hizo que. Un fallo aqui se loguea pero no tumba la accion. */
export async function audit(action: string, input: AuditInput = {}) {
  try {
    await db.auditLog.create({
      data: {
        action,
        userId: input.userId ?? null,
        target: input.target,
        detail: input.detail,
        ip: await clientIp(),
      },
    });
  } catch (err) {
    console.error("[audit] no se pudo registrar", action, err);
  }
}
