"use client";

import { useActionState } from "react";
import { setupAdmin } from "./actions";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export function SetupForm({ requireToken }: { requireToken: boolean }) {
  const [state, action] = useActionState(setupAdmin, undefined);
  const e = state?.fieldErrors;

  return (
    <form action={action} className="space-y-4" noValidate>
      {state?.error && <Alert>{state.error}</Alert>}
      {requireToken && (
        <Field
          label="Código de instalación"
          htmlFor="setupToken"
          hint="Es el valor de SETUP_TOKEN en tu archivo .env."
          errors={e?.setupToken}
        >
          <Input
            id="setupToken"
            name="setupToken"
            type="password"
            autoComplete="off"
            defaultValue={state?.values?.setupToken}
            required
          />
        </Field>
      )}
      <Field label="Tu nombre" htmlFor="name" errors={e?.name}>
        <Input id="name" name="name" autoComplete="name" defaultValue={state?.values?.name} required autoFocus />
      </Field>
      <Field label="Correo" htmlFor="email" errors={e?.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          defaultValue={state?.values?.email}
          required
        />
      </Field>
      <Field
        label="Contraseña"
        htmlFor="password"
        hint="Mínimo 10 caracteres, con letras y números."
        errors={e?.password}
      >
        <Input id="password" name="password" type="password" autoComplete="new-password" required />
      </Field>
      <Field label="Repite la contraseña" htmlFor="confirm" errors={e?.confirm}>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      <SubmitButton className="w-full" pendingText="Creando…">
        Crear administrador
      </SubmitButton>
    </form>
  );
}
