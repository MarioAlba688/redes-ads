"use client";

import { useActionState, useEffect, useRef } from "react";
import { changePassword } from "./actions";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export function PasswordForm() {
  const [state, action] = useActionState(changePassword, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const e = state?.fieldErrors;

  useEffect(() => {
    if (state?.success) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="max-w-sm space-y-4" noValidate>
      {state?.error && <Alert>{state.error}</Alert>}
      {state?.success && <Alert tone="success">{state.success}</Alert>}
      <Field label="Contraseña actual" htmlFor="current" errors={e?.current}>
        <Input id="current" name="current" type="password" autoComplete="current-password" required />
      </Field>
      <Field
        label="Contraseña nueva"
        htmlFor="password"
        hint="Mínimo 10 caracteres, con letras y números."
        errors={e?.password}
      >
        <Input id="password" name="password" type="password" autoComplete="new-password" required />
      </Field>
      <Field label="Repite la contraseña nueva" htmlFor="confirm" errors={e?.confirm}>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      <SubmitButton pendingText="Guardando…">Cambiar contraseña</SubmitButton>
    </form>
  );
}
