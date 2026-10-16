import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { db } from "@/lib/db";
import { generateToken, sha256Hex } from "@/lib/crypto";
import { env } from "@/lib/env";
import { clientIp } from "@/lib/audit";
import type { RoleName } from "@/lib/permissions";

export const SESSION_COOKIE = "redes_session";

/** La sesion vence tras 7 dias sin actividad (se renueva al usar la app). */
const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** La cookie dura 30 dias como maximo: pasado ese tiempo hay que volver a entrar. */
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
/** No renovamos en cada peticion, solo cuando pasó más de una hora. */
const RENEW_AFTER_MS = 60 * 60 * 1000;

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: RoleName;
  sessionId: string;
};

export async function createSession(userId: string) {
  const token = generateToken();
  const h = await headers();

  // Limpieza oportunista de sesiones vencidas.
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });

  await db.session.create({
    data: {
      userId,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + IDLE_TTL_MS),
      userAgent: h.get("user-agent")?.slice(0, 255) ?? null,
      ip: await clientIp(),
    },
  });

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    // Secure solo si la app se sirve por https (si no, el navegador descartaria la cookie).
    secure: env().APP_URL.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
  });
}

export async function destroyCurrentSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
  }
  store.delete(SESSION_COOKIE);
}

/**
 * Usuario de la sesion actual, o null. Consulta la base de datos en cada
 * peticion: si desactivas a alguien o le cambias el rol, el efecto es inmediato.
 * `cache` evita repetir la consulta dentro de un mismo render.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: {
      user: { select: { id: true, email: true, name: true, role: true, active: true } },
    },
  });

  if (!session || session.expiresAt <= new Date() || !session.user.active) {
    return null;
  }

  const remaining = session.expiresAt.getTime() - Date.now();
  if (IDLE_TTL_MS - remaining > RENEW_AFTER_MS) {
    await db.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() + IDLE_TTL_MS) },
    });
  }

  const { user } = session;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    sessionId: session.id,
  };
});
