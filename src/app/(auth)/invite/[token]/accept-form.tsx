"use client";

import { useActionState } from "react";
import { acceptInvitation } from "./actions";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export function AcceptForm({ token }: { token: string }) {
  const [state, action] = useActionState(acceptInvitation, undefined);
  const e = state?.fieldErrors;

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="token" value={token} />
      {state?.error && <Alert>{state.error}</Alert>}
      <Field label="Tu nombre" htmlFor="name" errors={e?.name}>
        <Input id="name" name="name" autoComplete="name" defaultValue={state?.values?.name} required autoFocus />
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
      <SubmitButton className="w-full" pendingText="Creando cuenta…">
        Crear mi cuenta
      </SubmitButton>
    </form>
  );
}
