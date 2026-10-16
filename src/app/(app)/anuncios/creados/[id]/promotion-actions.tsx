"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import type { FormState } from "@/lib/form-state";
import { maxTotalSpend } from "@/lib/promotions/validate";
import { activatePromotionAction, archivePromotionAction, changeBudgetAction, pausePromotionAction, syncPromotionAction } from "../../actions";

type Variant = "primary" | "secondary" | "danger";

function ActionForm({
  action,
  id,
  label,
  pendingText,
  variant = "secondary",
  confirm,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  id: string;
  label: string;
  pendingText: string;
  variant?: Variant;
  confirm?: string;
}) {
  const [state, formAction] = useActionState(action, undefined);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className="space-y-1"
    >
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant={variant} pendingText={pendingText}>
        {label}
      </SubmitButton>
      {state?.error && <p className="max-w-sm text-xs text-danger">{state.error}</p>}
      {state?.success && <p className="text-xs text-success">{state.success}</p>}
    </form>
  );
}

function BudgetForm({ id, budget, currency, cap }: { id: string; budget: number; currency: string; cap: number | null }) {
  const [state, action] = useActionState(changeBudgetAction, undefined);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="id" value={id} />
      <label htmlFor="nuevo-presupuesto" className="block text-xs font-medium">
        Presupuesto diario ({currency})
        {cap !== null && <span className="font-normal text-muted"> · tope {formatMoney(cap, currency)}</span>}
      </label>
      <div className="flex items-center gap-2">
        <Input id="nuevo-presupuesto" name="budget" inputMode="decimal" autoComplete="off" defaultValue={state?.values?.budget ?? String(budget)} className="w-36 py-1.5 text-sm" />
        <SubmitButton variant="secondary" small pendingText="Cambiando…">
          Cambiar
        </SubmitButton>
      </div>
      {state?.error && <p className="max-w-sm text-xs text-danger">{state.error}</p>}
      {state?.success && <p className="text-xs text-success">{state.success}</p>}
    </form>
  );
}

/** Lo que se puede hacer con un anuncio creado en la app, segun el estado y el permiso de quien lo mira. */
export function PromotionActions({
  id,
  status,
  canCreate,
  canApprove,
  budget,
  currency,
  cap,
  days,
}: {
  id: string;
  status: string;
  canCreate: boolean;
  canApprove: boolean;
  budget: number;
  currency: string;
  cap: number | null;
  days: number;
}) {
  const total = maxTotalSpend(budget, days, currency);
  const live = status === "ACTIVE" || status === "PAUSED";
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-3">
        {status === "PAUSED" && canApprove && (
          <ActionForm
            action={activatePromotionAction}
            id={id}
            label="Activar anuncio"
            pendingText="Activando…"
            variant="primary"
            confirm={`Esto empieza a gastar hasta ${formatMoney(budget, currency)} por día durante ${days} ${days === 1 ? "día" : "días"}${total !== null ? ` (máximo ${formatMoney(total, currency)})` : ""}. ¿Activar el anuncio?`}
          />
        )}
        {status === "ACTIVE" && (canCreate || canApprove) && <ActionForm action={pausePromotionAction} id={id} label="Pausar" pendingText="Pausando…" />}
        {live && (canCreate || canApprove) && <ActionForm action={syncPromotionAction} id={id} label="Actualizar estado" pendingText="Leyendo en Meta…" />}
        {status !== "ARCHIVED" && status !== "CREATING" && canApprove && (
          <ActionForm
            action={archivePromotionAction}
            id={id}
            label={status === "FAILED" ? "Descartar" : "Archivar"}
            pendingText={status === "FAILED" ? "Descartando…" : "Archivando…"}
            variant="danger"
            confirm={status === "FAILED" ? "Queda como archivado y ya no se puede crear de nuevo desde aquí (no quedó nada creado en Meta). ¿Descartar?" : "El anuncio se pausa y se archiva en Meta (se conservan sus cifras). ¿Archivar?"}
          />
        )}
      </div>
      {live && canApprove && <BudgetForm id={id} budget={budget} currency={currency} cap={cap} />}
      {status === "PAUSED" && !canApprove && <p className="text-sm text-muted">Está en pausa. Lo activa una persona con permiso de aprobar anuncios.</p>}
    </div>
  );
}
