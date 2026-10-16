"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { setSpendCapsAction } from "./actions";

/**
 * Topes de gasto de una cuenta publicitaria de Meta: por dia (obligatorio para crear o activar anuncios) y por mes
 * (opcional, tambien frena los anuncios activos al llegar). Los fija el administrador; los demas solo los ven.
 */
export function SpendCapsForm({
  accountId,
  currency,
  cap,
  monthlyCap,
  spent,
  canEdit,
}: {
  accountId: string;
  currency: string | null;
  cap: number | null;
  monthlyCap: number | null;
  /** Gastado en el mes en curso segun el rendimiento descargado de Meta. */
  spent: number;
  canEdit: boolean;
}) {
  const [state, action] = useActionState(setSpendCapsAction, undefined);
  const money = (v: number) => formatMoney(v, currency ?? "");
  const monthLine =
    monthlyCap !== null ? (
      <p className={`text-xs ${spent >= monthlyCap ? "font-medium text-danger" : "text-muted"}`}>
        Este mes: {money(spent)} de {money(monthlyCap)} ({Math.min(Math.round((spent / monthlyCap) * 100), 999)} %)
        {spent >= monthlyCap ? " — tope alcanzado: los anuncios activos de la app se pausan solos" : ""}
      </p>
    ) : (
      <p className="text-xs text-muted">Este mes: {money(spent)} (sin tope mensual)</p>
    );

  if (!canEdit) {
    return (
      <div className="mt-1.5 space-y-0.5 text-xs text-muted">
        <p>
          Tope diario por anuncio: {cap === null ? <span className="text-warning">sin fijar (no se pueden crear anuncios)</span> : <strong className="text-foreground">{money(cap)}</strong>}
        </p>
        <p>Tope mensual: {monthlyCap === null ? "sin fijar" : <strong className="text-foreground">{money(monthlyCap)}</strong>}</p>
        {monthLine}
      </div>
    );
  }

  return (
    <form action={action} className="mt-2 max-w-sm space-y-2">
      <input type="hidden" name="accountId" value={accountId} />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`cap-${accountId}`} className="block text-xs font-medium">
            Tope diario por anuncio {currency ? `(${currency})` : ""}
          </label>
          <Input
            id={`cap-${accountId}`}
            name="cap"
            inputMode="decimal"
            autoComplete="off"
            placeholder={cap === null ? "Sin fijar" : undefined}
            defaultValue={state?.values?.cap ?? (cap === null ? "" : String(cap))}
            className="mt-1 py-1.5 text-xs"
          />
        </div>
        <div>
          <label htmlFor={`capm-${accountId}`} className="block text-xs font-medium">
            Tope mensual {currency ? `(${currency})` : ""}
          </label>
          <Input
            id={`capm-${accountId}`}
            name="monthlyCap"
            inputMode="decimal"
            autoComplete="off"
            placeholder="Opcional"
            defaultValue={state?.values?.monthlyCap ?? (monthlyCap === null ? "" : String(monthlyCap))}
            className="mt-1 py-1.5 text-xs"
          />
        </div>
      </div>
      <SubmitButton variant="secondary" small pendingText="Guardando…">
        Guardar
      </SubmitButton>
      {monthLine}
      {cap === null && !state?.success && !state?.error && <p className="text-xs text-warning">Sin tope diario no se pueden crear ni activar anuncios en esta cuenta.</p>}
      {state?.error && <p className="text-xs text-danger">{state.error}</p>}
      {state?.success && <p className="text-xs text-success">{state.success}</p>}
    </form>
  );
}
