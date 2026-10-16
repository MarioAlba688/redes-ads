"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui";
import type { ComponentProps } from "react";

/** Boton de envio que se deshabilita mientras el formulario se procesa. */
export function SubmitButton({
  children,
  pendingText = "Procesando…",
  disabled,
  ...props
}: ComponentProps<typeof Button> & { pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" {...props} disabled={pending || disabled}>
      {pending ? pendingText : children}
    </Button>
  );
}
