import Link from "next/link";
import type { ReactNode } from "react";
import { NavLinks, type NavItem } from "@/components/nav-links";
import { logout } from "@/lib/auth/actions";
import type { SessionUser } from "@/lib/auth/session";
import { can, ROLE_LABELS } from "@/lib/permissions";

function navFor(user: SessionUser): NavItem[] {
  const items: NavItem[] = [{ href: "/", label: "Panel" }];
  if (can(user.role, "accounts.view")) items.push({ href: "/cuentas", label: "Cuentas" });
  if (can(user.role, "metrics.view")) items.push({ href: "/anuncios", label: "Anuncios" });
  if (can(user.role, "brands.view")) items.push({ href: "/marcas", label: "Marcas" });
  if (can(user.role, "content.view")) items.push({ href: "/publicaciones", label: "Publicaciones" });
  if (can(user.role, "metrics.view")) items.push({ href: "/estadisticas", label: "Estadísticas" });
  if (can(user.role, "ai.manage")) items.push({ href: "/ia", label: "Motores de IA" });
  if (can(user.role, "team.manage")) items.push({ href: "/equipo", label: "Equipo" });
  items.push({ href: "/manual", label: "Manual" });
  return items;
}

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const items = navFor(user);

  return (
    <div className="flex min-h-screen flex-1 flex-col md:flex-row">
      <aside className="border-b border-border bg-surface md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex h-full flex-col gap-4 p-3 md:p-4">
          <div className="flex items-center justify-between gap-3">
            <Link href="/" className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
                R
              </span>
              <span className="font-semibold tracking-tight">Redes</span>
            </Link>
            <div className="flex items-center gap-3 text-xs md:hidden">
              <Link href="/perfil" className="text-muted hover:text-foreground">
                Perfil
              </Link>
              <form action={logout}>
                <button type="submit" className="text-muted hover:text-foreground">
                  Salir
                </button>
              </form>
            </div>
          </div>

          <nav
            aria-label="Principal"
            className="-mx-1 flex gap-1 overflow-x-auto px-1 md:mx-0 md:flex-1 md:flex-col md:overflow-visible md:px-0"
          >
            <NavLinks items={items} />
          </nav>

          <div className="hidden border-t border-border pt-4 md:block">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted">{ROLE_LABELS[user.role]}</p>
            <div className="mt-3 flex items-center gap-3 text-xs">
              <Link href="/perfil" className="text-muted hover:text-foreground">
                Mi perfil
              </Link>
              <form action={logout}>
                <button type="submit" className="text-muted hover:text-foreground">
                  Cerrar sesión
                </button>
              </form>
            </div>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
