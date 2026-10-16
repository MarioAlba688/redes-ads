"use client";

import { useActionState, useState, useTransition, type FormEvent } from "react";
import { setDefaultEngine } from "./actions";
import { Alert, Button, Field, Select } from "@/components/ui";
import type { AiProviderId } from "@/lib/ai/catalog";

/** Motor que se propone primero en el editor. Se envia a mano para que el desplegable no vuelva a su valor inicial tras guardar. */
export function DefaultEngineForm({ ready, current }: { ready: { id: AiProviderId; label: string }[]; current: AiProviderId | "" }) {
  const [value, setValue] = useState<string>(current);
  const [state, action, pending] = useActionState(setDefaultEngine, undefined);
  const [, startTransition] = useTransition();

  const onSubmit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const data = new FormData(ev.currentTarget);
    startTransition(() => action(data));
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3" noValidate>
      <div className="min-w-56 flex-1">
        <Field label="Motor por defecto" htmlFor="default-engine" hint="Es el que aparece elegido al crear una publicación; cada persona puede cambiarlo.">
          <Select id="default-engine" name="provider" value={value} onChange={(ev) => setValue(ev.target.value)}>
            <option value="">Automático (el primero disponible)</option>
            {ready.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Guardando…" : "Guardar"}
      </Button>
      {state?.error && (
        <div className="basis-full">
          <Alert>{state.error}</Alert>
        </div>
      )}
      {state?.success && (
        <div className="basis-full">
          <Alert tone="success">{state.success}</Alert>
        </div>
      )}
    </form>
  );
}
