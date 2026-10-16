import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Alert } from "@/components/ui";
import { db } from "@/lib/db";
import { env, isProduction } from "@/lib/env";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Instalación" };

export default async function SetupPage() {
  // Fuerza render por peticion: depende de la base de datos y no debe prerenderizarse al compilar.
  await connection();

  // Una vez creado el primer usuario, esta pagina deja de existir.
  if ((await db.user.count()) > 0) redirect("/login");

  const token = env().SETUP_TOKEN;
  const blocked = isProduction() && !token;

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">Crear administrador</h1>
      <p className="mb-4 mt-1 text-sm text-muted">
        Esta será la primera cuenta. Desde ella invitarás al resto del equipo.
      </p>
      {blocked ? (
        <Alert tone="warning">
          Por seguridad, en producción hace falta definir <code>SETUP_TOKEN</code> en el archivo{" "}
          <code>.env</code> (mínimo 8 caracteres) y reiniciar la app.
        </Alert>
      ) : (
        <SetupForm requireToken={Boolean(token)} />
      )}
    </>
  );
}
