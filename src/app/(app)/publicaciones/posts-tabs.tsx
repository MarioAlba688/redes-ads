import Link from "next/link";

/** Alterna entre la lista y el calendario de publicaciones. */
export function PostsViewTabs({ active }: { active: "lista" | "calendario" }) {
  const item = (key: "lista" | "calendario", href: string, label: string) => (
    <Link
      href={href}
      aria-current={active === key ? "page" : undefined}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
        active === key ? "bg-primary/10 font-semibold text-primary" : "text-muted hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <div role="group" aria-label="Vista" className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {item("lista", "/publicaciones", "Lista")}
      {item("calendario", "/publicaciones/calendario", "Calendario")}
    </div>
  );
}
