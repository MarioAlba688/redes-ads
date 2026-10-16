import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth/dal";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // Cada pagina vuelve a llamar requireUser(): los layouts no se re-ejecutan al
  // navegar, asi que no pueden ser la unica barrera de acceso.
  const user = await requireUser();
  return <AppShell user={user}>{children}</AppShell>;
}
