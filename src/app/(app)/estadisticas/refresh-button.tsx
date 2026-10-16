"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/submit-button";
import { Alert } from "@/components/ui";
import { refreshStatsAction } from "./actions";

/** «Actualizar»: vuelve a leer en Meta las cifras de las publicaciones que se estan viendo. */
export function RefreshStatsButton({ days, brandId, network }: { days: number; brandId: string | null; network: string | null }) {
  const [state, action] = useActionState(refreshStatsAction, undefined);
  return (
    <form action={action} className="flex max-w-sm flex-col items-end gap-2">
      <input type="hidden" name="dias" value={days} />
      <input type="hidden" name="marca" value={brandId ?? ""} />
      <input type="hidden" name="red" value={network ?? ""} />
      <SubmitButton variant="secondary" pendingText="Leyendo en Meta…">
        Actualizar
      </SubmitButton>
      {state?.error && <Alert>{state.error}</Alert>}
      {state?.success && <Alert tone="success">{state.success}</Alert>}
    </form>
  );
}
