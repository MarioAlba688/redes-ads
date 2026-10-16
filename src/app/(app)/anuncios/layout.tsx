import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/dal";
import { AdsTabs } from "./ads-tabs";

// Solo agrega las pestañas. No es una barrera de seguridad: cada pagina y cada accion comprueba el permiso por su cuenta.
export default async function AdsLayout({ children }: { children: ReactNode }) {
  await requireUser("metrics.view");
  return (
    <>
      <AdsTabs />
      {children}
    </>
  );
}
