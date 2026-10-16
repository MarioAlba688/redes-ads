"use client";

import { useActionState, useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { changeRole, createInvitation, setUserActive } from "./actions";
import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type RoleName } from "@/lib/permissions";

export function InviteForm() {
  const [state, action, pending] = useActionState(createInvitation, undefined);
  const [, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);
  const [role, setRole] = useState<RoleName>("EDITOR");
  const emailRef = useRef<HTMLInputElement>(null);

  // Envio a mano en lugar de `<form action>`: con `action`, React 19 vacia el formulario tras cada envio y el
  // desplegable de rol (que controlamos con estado) volvia a «Administrador» sin avisar: la siguiente
  // invitacion habria salido con el rol mas alto sin que nadie lo eligiera.
  const onSubmit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const data = new FormData(ev.currentTarget);
    startTransition(() => action(data));
  };

  // Tras crear una invitacion se limpia solo el correo; el rol elegido se conserva.
  useEffect(() => {
    if (state?.inviteLink && emailRef.current) emailRef.current.value = "";
  }, [state?.inviteLink]);

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sin permiso de portapapeles: la persona puede seleccionar el texto a mano.
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-[1fr_14rem_auto] sm:items-start">
        <Field label="Correo de la persona" htmlFor="invite-email" errors={state?.fieldErrors?.email}>
          <Input id="invite-email" name="email" type="email" required placeholder="nombre@empresa.com" ref={emailRef} />
        </Field>
        <Field label="Rol" htmlFor="invite-role" errors={state?.fieldErrors?.role}>
          <Select
            id="invite-role"
            name="role"
            value={role}
            onChange={(e) => setRole(e.target.value as RoleName)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:pt-[1.625rem]">
          <Button type="submit" disabled={pending}>
            {pending ? "Creando…" : "Crear invitación"}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted">{ROLE_DESCRIPTIONS[role]}</p>

      {state?.error && <Alert>{state.error}</Alert>}
      {state?.inviteLink && (
        <Alert tone="success">
          <p className="mb-2 font-medium">{state.success}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              readOnly
              value={state.inviteLink}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Link de invitación"
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-foreground"
            />
            <Button type="button" variant="secondary" small onClick={() => copy(state.inviteLink!)}>
              {copied ? "Copiado" : "Copiar"}
            </Button>
          </div>
          <p className="mt-2 text-xs">
            Este link se muestra una sola vez y vence en 7 días. Si lo pierdes, crea otra invitación.
          </p>
        </Alert>
      )}
    </form>
  );
}

export function RoleSelect({
  userId,
  role,
  disabled,
}: {
  userId: string;
  role: RoleName;
  disabled?: boolean;
}) {
  const [state, action] = useActionState(changeRole, undefined);

  return (
    <form action={action}>
      <input type="hidden" name="userId" value={userId} />
      <Select
        name="role"
        defaultValue={role}
        disabled={disabled}
        aria-label="Rol"
        className="w-40 py-1.5"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </Select>
      {state?.error && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}

export function ActiveButton({
  userId,
  active,
  disabled,
}: {
  userId: string;
  active: boolean;
  disabled?: boolean;
}) {
  const [state, action] = useActionState(setUserActive, undefined);

  return (
    <form action={action}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <SubmitButton variant={active ? "danger" : "secondary"} small disabled={disabled} pendingText="…">
        {active ? "Desactivar" : "Reactivar"}
      </SubmitButton>
      {state?.error && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}
