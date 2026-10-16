"use client";

import { useState } from "react";

/** Copia un texto al portapapeles (para pegar sin errores direcciones y lineas del .env). */
export function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      // Sin permiso del navegador (o sin HTTPS): se deja el texto seleccionable en el bloque de al lado.
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-muted transition-colors hover:text-foreground"
    >
      <span aria-live="polite">{state === "copied" ? "¡Copiado!" : state === "failed" ? "Cópialo a mano" : label}</span>
    </button>
  );
}
