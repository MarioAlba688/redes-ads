"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = {
  href: string;
  label: string;
  /** Texto de la etiqueta (ej. "Fase 2"). Si hay etiqueta, el item queda deshabilitado. */
  soon?: string;
};

export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <>
      {items.map((item) => {
        if (item.soon) {
          return (
            <span
              key={item.href}
              aria-disabled="true"
              className="flex shrink-0 items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-muted/60"
            >
              {item.label}
              <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium">
                {item.soon}
              </span>
            </span>
          );
        }
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex shrink-0 items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-primary/10 text-primary"
                : "text-muted hover:bg-background hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
