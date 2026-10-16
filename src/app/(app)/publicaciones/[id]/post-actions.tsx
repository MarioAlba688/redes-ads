"use client";

import { useActionState, useTransition, type FormEvent, type ReactNode } from "react";
import { approvePost, cancelPost, publishNowAction, retryPost, returnPost, schedulePost, submitForReview } from "./actions";
import { Alert, Button, Card, Field, Input, Textarea } from "@/components/ui";
import type { FormState } from "@/lib/form-state";
import type { PostAction } from "@/lib/post-workflow";

type ServerAction = (prev: FormState, data: FormData) => Promise<FormState>;

/**
 * Una accion del flujo. Se envia a mano (sin `<form action>`) para que, si hay un error, los campos queden
 * como la persona los dejo en lugar de vaciarse.
 */
function ActionForm({
  postId,
  action,
  title,
  description,
  submitLabel,
  pendingLabel,
  variant = "primary",
  confirm,
  children,
}: {
  postId: string;
  action: ServerAction;
  title: string;
  description?: string;
  submitLabel: string;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "danger";
  confirm?: string;
  children?: ReactNode;
}) {
  const [state, run, pending] = useActionState(action, undefined);
  const [, startTransition] = useTransition();

  const onSubmit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    if (confirm && !window.confirm(confirm)) return;
    const data = new FormData(ev.currentTarget);
    startTransition(() => run(data));
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      <input type="hidden" name="id" value={postId} />
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {children}
      {state?.error && (
        <Alert>
          <span className="whitespace-pre-line">{state.error}</span>
        </Alert>
      )}
      {state?.success && <Alert tone="success">{state.success}</Alert>}
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}

export function PostActions({
  postId,
  actions,
  timezone,
  defaultWhen,
  minWhen,
  scheduled,
}: {
  postId: string;
  actions: PostAction[];
  timezone: string;
  /** Hora sugerida ("2026-10-16T09:00") en la zona de la marca. */
  defaultWhen: string;
  minWhen: string;
  scheduled: boolean;
}) {
  if (actions.length === 0) return null;
  const has = (a: PostAction) => actions.includes(a);
  const tz = timezone.replace(/_/g, " ");

  const whenField = (required: boolean) => (
    <Field label={`Fecha y hora (${tz})`} htmlFor={`when-${required ? "s" : "a"}`}>
      <Input
        id={`when-${required ? "s" : "a"}`}
        name="when"
        type="datetime-local"
        defaultValue={required ? defaultWhen : ""}
        min={minWhen}
        required={required}
      />
    </Field>
  );

  return (
    <Card className="divide-y divide-border">
      {has("submit") && (
        <div className="p-5">
          <ActionForm
            postId={postId}
            action={submitForReview}
            title="Enviar a revisión"
            description="Guarda los cambios antes. Quien apruebe recibirá la publicación y podrá programarla."
            submitLabel="Enviar a revisión"
            pendingLabel="Enviando…"
          />
        </div>
      )}

      {has("approve") && (
        <div className="p-5">
          <ActionForm
            postId={postId}
            action={approvePost}
            title="Aprobar"
            description="Si eliges fecha y hora, queda programada; si no, queda aprobada y la programas después."
            submitLabel="Aprobar"
            pendingLabel="Aprobando…"
          >
            {whenField(false)}
            <Field label="Nota (opcional)" htmlFor="approve-note">
              <Textarea id="approve-note" name="note" rows={2} />
            </Field>
          </ActionForm>
        </div>
      )}

      {has("return") && (
        <div className="p-5">
          <ActionForm
            postId={postId}
            action={returnPost}
            title="Devolver con una nota"
            description="Vuelve a ser un borrador para que la persona que la escribió haga los cambios."
            submitLabel="Devolver al editor"
            pendingLabel="Devolviendo…"
            variant="secondary"
          >
            <Field label="¿Qué hay que cambiar?" htmlFor="return-note">
              <Textarea id="return-note" name="note" rows={3} required />
            </Field>
          </ActionForm>
        </div>
      )}

      {has("schedule") && (
        <div className="p-5">
          <ActionForm
            postId={postId}
            action={schedulePost}
            title={scheduled ? "Reprogramar" : "Programar"}
            description="Se publica sola a esa hora, en todos sus destinos."
            submitLabel={scheduled ? "Reprogramar" : "Programar"}
            pendingLabel="Guardando…"
          >
            {whenField(true)}
          </ActionForm>
        </div>
      )}

      {has("publishNow") && (
        <div className="p-5">
          <ActionForm
            postId={postId}
            action={publishNowAction}
            title="Publicar ahora"
            description="Sale en los próximos segundos, sin esperar a la hora programada."
            submitLabel="Publicar ahora"
            pendingLabel="Enviando…"
            variant="secondary"
            confirm="¿Publicar ahora en todos los destinos? Esto no se puede deshacer."
          />
        </div>
      )}

      {has("retry") && (
        <div className="p-5">
          <ActionForm
            postId={postId}
            action={retryPost}
            title="Reintentar"
            description="Vuelve a intentar solo los destinos que fallaron; los que ya salieron no se repiten."
            submitLabel="Reintentar los que fallaron"
            pendingLabel="Enviando…"
          />
        </div>
      )}

      {has("cancel") && (
        <div className="p-5">
          <ActionForm
            postId={postId}
            action={cancelPost}
            title="Cancelar publicación"
            description="No se publicará. El texto se conserva."
            submitLabel="Cancelar publicación"
            pendingLabel="Cancelando…"
            variant="danger"
            confirm="¿Cancelar esta publicación?"
          />
        </div>
      )}
    </Card>
  );
}
