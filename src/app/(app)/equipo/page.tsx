import type { Metadata } from "next";
import { Badge, Button, Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { dateTimeFormat } from "@/lib/display-time";
import { db } from "@/lib/db";
import { ROLE_LABELS } from "@/lib/permissions";
import { revokeInvitation } from "./actions";
import { ActiveButton, InviteForm, RoleSelect } from "./team-controls";

export const metadata: Metadata = { title: "Equipo" };

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "inició sesión",
  "auth.logout": "cerró sesión",
  "auth.password_changed": "cambió su contraseña",
  "setup.admin_created": "creó la cuenta de administrador",
  "team.invited": "invitó a",
  "team.invitation_accepted": "aceptó su invitación",
  "team.invitation_revoked": "revocó la invitación de",
  "team.role_changed": "cambió el rol de",
  "team.user_deactivated": "desactivó a",
  "team.user_activated": "reactivó a",
};

/**
 * Motivo tecnico de un fallo (para quien administra): solo en los eventos de Meta que fallaron o
 * que dejaron cuentas sin guardar. El detalle nunca contiene tokens (ver lib/errors.ts).
 */
function technicalDetail(action: string, detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  const failed = action === "meta.connect_failed" || (action === "meta.connected" && d.skipped);
  return failed ? JSON.stringify(detail).slice(0, 600) : null;
}

export default async function TeamPage() {
  const me = await requireUser("team.manage");

  const [users, invitations, activity] = await Promise.all([
    db.user.findMany({
      select: { id: true, name: true, email: true, role: true, active: true, lastLoginAt: true },
      orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    }),
    db.invitation.findMany({
      where: { acceptedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, email: true, role: true, expiresAt: true },
      orderBy: { createdAt: "desc" },
    }),
    db.auditLog.findMany({
      take: 15,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        action: true,
        target: true,
        detail: true,
        createdAt: true,
        user: { select: { name: true } },
      },
    }),
  ]);

  const dateFmt = dateTimeFormat();

  return (
    <>
      <PageHeader title="Equipo" description="Quién tiene acceso y qué puede hacer." />

      <Card className="p-5">
        <h2 className="mb-4 font-semibold">Invitar a alguien</h2>
        <InviteForm />
      </Card>

      {invitations.length > 0 && (
        <Card className="mt-6">
          <div className="border-b border-border px-5 py-4">
            <h2 className="font-semibold">Invitaciones pendientes</h2>
          </div>
          <ul className="divide-y divide-border">
            {invitations.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <span className="font-medium">{inv.email}</span>
                <Badge>{ROLE_LABELS[inv.role]}</Badge>
                <span className="text-xs text-muted">vence {dateFmt.format(inv.expiresAt)}</span>
                <form action={revokeInvitation} className="ml-auto">
                  <input type="hidden" name="id" value={inv.id} />
                  <Button type="submit" variant="danger" small>
                    Revocar
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-semibold">Personas</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Persona</th>
                <th className="px-5 py-2.5 font-medium">Rol</th>
                <th className="px-5 py-2.5 font-medium">Último acceso</th>
                <th className="px-5 py-2.5 font-medium">Estado</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.map((u) => {
                const isMe = u.id === me.id;
                return (
                  <tr key={u.id} className={u.active ? "" : "opacity-60"}>
                    <td className="px-5 py-3">
                      <p className="font-medium">
                        {u.name} {isMe && <span className="text-xs font-normal text-muted">(tú)</span>}
                      </p>
                      <p className="text-xs text-muted">{u.email}</p>
                    </td>
                    <td className="px-5 py-3 align-top">
                      <RoleSelect userId={u.id} role={u.role} disabled={isMe || !u.active} />
                    </td>
                    <td className="px-5 py-3 text-muted">
                      {u.lastLoginAt ? dateFmt.format(u.lastLoginAt) : "Nunca"}
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={u.active ? "success" : "neutral"}>
                        {u.active ? "Activa" : "Desactivada"}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-right align-top">
                      {!isMe && <ActiveButton userId={u.id} active={u.active} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-6">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-semibold">Actividad reciente</h2>
        </div>
        {activity.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">Sin actividad todavía.</p>
        ) : (
          <ul className="divide-y divide-border">
            {activity.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 px-5 py-2.5 text-sm">
                {a.action === "auth.login_failed" ? (
                  // El actor aqui no es quien hizo la accion (nadie inicio sesion), asi que no lo nombramos.
                  <>
                    <span className="font-medium text-warning">Intento de acceso fallido</span>
                    {a.target && <span className="text-muted">con {a.target}</span>}
                  </>
                ) : (
                  <>
                    <span className="font-medium">{a.user?.name ?? "Sistema"}</span>
                    <span className="text-muted">
                      {ACTION_LABELS[a.action] ?? a.action}
                      {a.target ? ` ${a.target}` : ""}
                    </span>
                  </>
                )}
                <span className="ml-auto text-xs text-muted">{dateFmt.format(a.createdAt)}</span>
                {technicalDetail(a.action, a.detail) && (
                  <p className="basis-full break-words font-mono text-xs text-muted">{technicalDetail(a.action, a.detail)}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
