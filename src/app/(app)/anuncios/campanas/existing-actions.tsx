"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { setExistingBudgetAction, setExistingStatusAction } from "../actions";

type Level = "campaign" | "adset" | "ad";

function StatusForm({ adAccountId, level, objectId, to, label, confirm }: { adAccountId: string; level: Level; objectId: string; to: "ACTIVE" | "PAUSED"; label: string; confirm?: string }) {
  const [state, action] = useActionState(setExistingStatusAction, undefined);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className="space-y-1"
    >
      <input type="hidden" name="adAccountId" value={adAccountId} />
      <input type="hidden" name="level" value={level} />
      <input type="hidden" name="objectId" value={objectId} />
      <input type="hidden" name="status" value={to} />
      <SubmitButton variant={to === "ACTIVE" ? "primary" : "secondary"} small pendingText="…">
        {label}
      </SubmitButton>
      {state?.error && <p className="max-w-xs text-xs text-danger">{state.error}</p>}
      {state?.success && <p className="text-xs text-success">{state.success}</p>}
    </form>
  );
}

function BudgetForm({ adAccountId, level, objectId, budget, currency, cap }: { adAccountId: string; level: Level; objectId: string; budget: number; currency: string; cap: number | null }) {
  const [state, action] = useActionState(setExistingBudgetAction, undefined);
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="adAccountId" value={adAccountId} />
      <input type="hidden" name="level" value={level} />
      <input type="hidden" name="objectId" value={objectId} />
      <div className="flex items-center gap-1.5">
        <Input
          name="budget"
          inputMode="decimal"
          autoComplete="off"
          aria-label={`Presupuesto diario en ${currency}${cap !== null ? ` (tope ${formatMoney(cap, currency)})` : ""}`}
          defaultValue={state?.values?.budget ?? String(budget)}
          className="w-28 py-1 text-xs"
        />
        <SubmitButton variant="secondary" small pendingText="…">
          Cambiar
        </SubmitButton>
      </div>
      {state?.error && <p className="max-w-xs text-xs text-danger">{state.error}</p>}
      {state?.success && <p className="text-xs text-success">{state.success}</p>}
    </form>
  );
}

/** Acciones de una fila de «Campañas en Meta»: pausar, activar (solo quien aprueba) y cambiar el presupuesto diario. */
export function ExistingRowActions({
  adAccountId,
  level,
  objectId,
  status,
  canPause,
  canActivate,
  budget,
  currency,
  cap,
}: {
  adAccountId: string;
  level: Level;
  objectId: string;
  /** Estado propio del objeto (no el efectivo): ACTIVE o PAUSED. */
  status: string | null;
  canPause: boolean;
  canActivate: boolean;
  /** Presupuesto diario que se puede cambiar en este objeto (unidades normales), o null si no tiene o no es editable. */
  budget: number | null;
  currency: string;
  cap: number | null;
}) {
  return (
    <div className="flex flex-wrap items-start justify-end gap-2">
      {status === "ACTIVE" && canPause && <StatusForm adAccountId={adAccountId} level={level} objectId={objectId} to="PAUSED" label="Pausar" />}
      {status === "PAUSED" && canActivate && (
        <StatusForm adAccountId={adAccountId} level={level} objectId={objectId} to="ACTIVE" label="Activar" confirm="Esto puede empezar a gastar dinero hasta el presupuesto diario que tenga. ¿Activar?" />
      )}
      {budget !== null && canActivate && <BudgetForm adAccountId={adAccountId} level={level} objectId={objectId} budget={budget} currency={currency} cap={cap} />}
    </div>
  );
}
