import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";

export const metadata: Metadata = { title: "Sin permiso" };

export default async function NoAccessPage() {
  await requireUser();
  return (
    <Card className="mx-auto mt-16 max-w-md p-8 text-center">
      <h1 className="text-xl font-semibold tracking-tight">No tienes permiso</h1>
      <p className="mt-2 text-sm text-muted">
        Tu rol no permite entrar a esta sección. Si crees que es un error, habla con un
        administrador.
      </p>
      <Link href="/" className="mt-5 inline-block text-sm font-medium text-primary hover:underline">
        Volver al panel
      </Link>
    </Card>
  );
}
