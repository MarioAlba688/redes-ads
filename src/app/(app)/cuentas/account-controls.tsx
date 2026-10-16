"use client";

import { useActionState } from "react";
import { disconnectAccountAction, syncAccountAction, syncAllAction } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert } from "@/components/ui";

export function AccountRowActions({
  accountId,
  canSync,
  canDisconnect,
}: {
  accountId: string;
  canSync: boolean;
  canDisconnect: boolean;
}) {
  const [syncState, syncAction] = useActionState(syncAccountAction, undefined);
  const [discState, discAction] = useActionState(disconnectAccountAction, undefined);
  const message = syncState?.error ?? discState?.error;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {canSync && (
          <form action={syncAction}>
            <input type="hidden" name="accountId" value={accountId} />
            <SubmitButton variant="secondary" small pendingText="Sincronizando…">
              Sincronizar
            </SubmitButton>
          </form>
        )}
        {canDisconnect && (
          <form
            action={discAction}
            onSubmit={(e) => {
              if (!window.confirm("¿Desconectar esta cuenta? Se borran sus tokens; el historial de anuncios se conserva.")) {
                e.preventDefault();
              }
            }}
          >
            <input type="hidden" name="accountId" value={accountId} />
            <SubmitButton variant="danger" small pendingText="…">
              Desconectar
            </SubmitButton>
          </form>
        )}
      </div>
      {message && <p className="max-w-xs text-right text-xs text-danger">{message}</p>}
      {!message && syncState?.success && <p className="text-xs text-success">{syncState.success}</p>}
    </div>
  );
}

/** Boton "Sincronizar todas las cuentas publicitarias" (de cualquier plataforma). */
export function SyncAllButton() {
  const [state, action] = useActionState(syncAllAction, undefined);
  return (
    <form action={action} className="flex flex-col items-end gap-2">
      <SubmitButton variant="secondary" pendingText="Sincronizando…">
        Sincronizar todas
      </SubmitButton>
      {state?.error && <Alert>{state.error}</Alert>}
      {state?.success && <Alert tone="success">{state.success}</Alert>}
    </form>
  );
}
