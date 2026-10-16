import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/components/ui";
import { sha256Hex } from "@/lib/crypto";
import { db } from "@/lib/db";
import { ROLE_LABELS } from "@/lib/permissions";
import { AcceptForm } from "./accept-form";

export const metadata: Metadata = { title: "Aceptar invitación" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;

  const invitation = await db.invitation.findUnique({
    where: { tokenHash: sha256Hex(token) },
    select: { email: true, role: true, expiresAt: true, acceptedAt: true },
  });
  const valid = invitation && !invitation.acceptedAt && invitation.expiresAt > new Date();

  if (!valid) {
    return (
      <>
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Invitación no válida</h1>
        <Alert tone="warning">
          Esta invitación no existe, ya se usó o venció. Pide una nueva al administrador.
        </Alert>
        <p className="mt-4 text-sm">
          <Link href="/login" className="font-medium text-primary hover:underline">
            Ir a iniciar sesión
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Te invitaron al equipo</h1>
      <p className="mb-4 mt-1 text-sm text-muted">
        Vas a entrar como <strong>{ROLE_LABELS[invitation.role]}</strong> con el correo{" "}
        <strong>{invitation.email}</strong>.
      </p>
      <AcceptForm token={token} />
    </>
  );
}
