import type { Metadata } from "next";
import { Badge, Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { ROLE_LABELS } from "@/lib/permissions";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Mi perfil" };

export default async function ProfilePage() {
  const user = await requireUser();

  return (
    <>
      <PageHeader title="Mi perfil" />

      <Card className="p-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted">Nombre</dt>
            <dd className="mt-0.5 font-medium">{user.name}</dd>
          </div>
          <div>
            <dt className="text-muted">Correo</dt>
            <dd className="mt-0.5 font-medium">{user.email}</dd>
          </div>
          <div>
            <dt className="text-muted">Rol</dt>
            <dd className="mt-0.5">
              <Badge tone="primary">{ROLE_LABELS[user.role]}</Badge>
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="mt-6 p-5">
        <h2 className="mb-4 font-semibold">Cambiar contraseña</h2>
        <PasswordForm />
      </Card>
    </>
  );
}
