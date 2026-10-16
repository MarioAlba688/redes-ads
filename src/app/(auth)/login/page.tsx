import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Iniciar sesión" };

export default async function LoginPage() {
  // Si ya hay una sesion valida, no mostramos el login.
  if (await getSessionUser()) redirect("/");

  const needsSetup = (await db.user.count()) === 0;

  return (
    <>
      <h1 className="mb-4 text-xl font-semibold tracking-tight">Iniciar sesión</h1>
      {needsSetup ? (
        <p className="text-sm text-muted">
          Aún no hay usuarios.{" "}
          <Link href="/setup" className="font-medium text-primary hover:underline">
            Crea la cuenta de administrador
          </Link>{" "}
          para empezar.
        </p>
      ) : (
        <LoginForm />
      )}
    </>
  );
}
