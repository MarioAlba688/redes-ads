import "server-only";
import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { can, type Permission } from "@/lib/permissions";

/**
 * Para paginas: exige sesion (y opcionalmente un permiso). Sin sesion manda a
 * /login; con sesion pero sin permiso manda a /sin-permiso.
 */
export async function requireUser(permission?: Permission): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (permission && !can(user.role, permission)) redirect("/sin-permiso");
  return user;
}

export type AuthResult =
  | { ok: true; user: SessionUser }
  | { ok: false; error: string };

/**
 * Para Server Actions: igual que requireUser pero devuelve un error en lugar de
 * redirigir. Toda accion que modifica datos debe llamarla: ocultar un boton en
 * la interfaz no protege nada.
 */
export async function authorize(permission?: Permission): Promise<AuthResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Tu sesión expiró. Vuelve a iniciar sesión." };
  if (permission && !can(user.role, permission)) {
    return { ok: false, error: "No tienes permiso para hacer esto." };
  }
  return { ok: true, user };
}
