"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/anuncios", label: "Rendimiento", match: (p: string) => p === "/anuncios" },
  { href: "/anuncios/creados", label: "Creados en la app", match: (p: string) => p.startsWith("/anuncios/creados") || p.startsWith("/anuncios/nuevo") },
  { href: "/anuncios/campanas", label: "Campañas en Meta", match: (p: string) => p.startsWith("/anuncios/campanas") },
];

/** Pestañas de la seccion Anuncios: rendimiento (cifras), lo creado desde la app y las campañas de Meta. */
export function AdsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Anuncios" className="-mt-2 mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors ${
              active ? "border-primary font-semibold text-primary" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
