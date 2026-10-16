"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { setDailyCapAction } from "./actions";

/** Tope de gasto diario por anuncio de una cuenta publicitaria de Meta: lo fija el administrador; los demas solo lo ven. */
export function DailyCapForm({ accountId, currency, cap, canEdit }: { accountId: string; currency: string | null; cap: number | null; canEdit: boolean }) {
  const [state, action] = useActionState(setDailyCapAction, undefined);
  const label = "Tope de gasto diario por anuncio";

  if (!canEdit) {
    return (
      <p className="mt-1.5 text-xs text-muted">
        {label}: {cap === null ? <span className="text-warning">sin fijar (no se pueden crear anuncios)</span> : <strong className="text-foreground">{formatMoney(cap, currency ?? "")}</strong>}
      </p>
    );
  }

  return (
    <form action={action} className="mt-2 max-w-xs space-y-1">
      <input type="hidden" name="accountId" value={accountId} />
      <label htmlFor={`cap-${accountId}`} className="block text-xs font-medium">
        {label} {currency ? `(${currency})` : ""}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={`cap-${accountId}`}
          name="cap"
          inputMode="decimal"
          autoComplete="off"
          placeholder={cap === null ? "Sin fijar" : undefined}
          defaultValue={state?.values?.cap ?? (cap === null ? "" : String(cap))}
          className="py-1.5 text-xs"
        />
        <SubmitButton variant="secondary" small pendingText="…">
          Guardar
        </SubmitButton>
      </div>
      {cap === null && !state?.success && !state?.error && <p className="text-xs text-warning">Sin tope no se pueden crear ni activar anuncios en esta cuenta.</p>}
      {state?.error && <p className="text-xs text-danger">{state.error}</p>}
      {state?.success && <p className="text-xs text-success">{state.success}</p>}
    </form>
  );
}
