import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, PageHeader, buttonClass } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { dateTimeFormat } from "@/lib/display-time";
import { can } from "@/lib/permissions";
import { ACCOUNT_KIND_LABELS } from "@/lib/platforms";
import { POST_STATUSES, POST_STATUS_LABELS, POST_STATUS_TONES, type PostStatusName } from "@/lib/posts";
import { PostsViewTabs } from "./posts-tabs";

export const metadata: Metadata = { title: "Publicaciones" };

const FILTERS: { key: string; label: string; statuses: PostStatusName[] | null }[] = [
  { key: "todas", label: "Todas", statuses: null },
  { key: "borradores", label: "Borradores", statuses: ["DRAFT"] },
  { key: "revision", label: "En revisión", statuses: ["IN_REVIEW"] },
  { key: "programadas", label: "Programadas", statuses: ["APPROVED", "SCHEDULED", "PUBLISHING"] },
  { key: "publicadas", label: "Publicadas", statuses: ["PUBLISHED", "PARTIAL"] },
  { key: "problemas", label: "Con problemas", statuses: ["FAILED", "CANCELLED"] },
];

export default async function PostsPage({ searchParams }: PageProps<"/publicaciones">) {
  const user = await requireUser("content.view");
  const q = await searchParams;
  const filter = FILTERS.find((f) => f.key === q.estado) ?? FILTERS[0];

  const [posts, grouped] = await Promise.all([
    db.post.findMany({
      where: filter.statuses ? { status: { in: filter.statuses } } : undefined,
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        text: true,
        status: true,
        scheduledAt: true,
        createdAt: true,
        aiGenerated: true,
        brand: { select: { name: true, timezone: true } },
        createdBy: { select: { name: true } },
        targets: { select: { account: { select: { name: true, kind: true } } } },
      },
    }),
    db.post.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const counts = new Map<string, number>(grouped.map((g) => [g.status, g._count._all]));
  const countFor = (f: (typeof FILTERS)[number]) =>
    f.statuses ? f.statuses.reduce((n, s) => n + (counts.get(s) ?? 0), 0) : [...counts.values()].reduce((a, b) => a + b, 0);
  const dateFmt = dateTimeFormat();
  // La hora de una publicacion programada es la de la zona de su marca; el resto, la de la app.
  const byZone = new Map<string, Intl.DateTimeFormat>();
  const scheduledFmt = (timeZone: string) => {
    if (!byZone.has(timeZone)) byZone.set(timeZone, dateTimeFormat({ timeZone }));
    return byZone.get(timeZone)!;
  };

  return (
    <>
      <PageHeader
        title="Publicaciones"
        description="Borradores, revisión y publicaciones de todas tus marcas."
        action={
          <div className="flex flex-wrap items-center gap-3">
            <PostsViewTabs active="lista" />
            {can(user.role, "content.create") && (
              <Link href="/publicaciones/nueva" className={buttonClass("primary")}>
                Nueva publicación
              </Link>
            )}
          </div>
        }
      />

      <nav aria-label="Filtrar por estado" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "todas" ? "/publicaciones" : `/publicaciones?estado=${f.key}`}
            aria-current={f.key === filter.key ? "true" : undefined}
            className={`rounded-full border px-3 py-1 text-sm transition-colors ${
              f.key === filter.key ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-muted hover:text-foreground"
            }`}
          >
            {f.label} <span className="tabular-nums opacity-70">{countFor(f)}</span>
          </Link>
        ))}
      </nav>

      {posts.length === 0 ? (
        <Card className="mx-auto mt-6 max-w-lg p-8 text-center">
          <h2 className="text-lg font-semibold">{filter.statuses ? "No hay publicaciones en este estado" : "Todavía no hay publicaciones"}</h2>
          <p className="mt-2 text-sm text-muted">
            {filter.statuses ? "Prueba con otro filtro." : "Crea la primera con ayuda de la IA: eliges la marca, cuentas de qué quieres publicar y ajustas el texto."}
          </p>
          {!filter.statuses && can(user.role, "content.create") && (
            <Link href="/publicaciones/nueva" className={`${buttonClass("primary")} mt-5`}>
              Crear la primera publicación
            </Link>
          )}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {posts.map((p) => {
              const status = p.status as PostStatusName;
              return (
                <li key={p.id}>
                  <Link href={`/publicaciones/${p.id}`} className="block px-5 py-4 transition-colors hover:bg-background">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={POST_STATUS_TONES[status]}>{POST_STATUS_LABELS[status]}</Badge>
                      <span className="text-sm font-medium">{p.brand.name}</span>
                      {p.aiGenerated && <Badge tone="primary">IA</Badge>}
                      <span className="ml-auto text-xs text-muted">
                        {p.scheduledAt ? `Programada ${scheduledFmt(p.brand.timezone).format(p.scheduledAt)}` : `Creada ${dateFmt.format(p.createdAt)}`}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 whitespace-pre-line text-sm">{p.text}</p>
                    <p className="mt-2 text-xs text-muted">
                      {p.targets.length > 0
                        ? p.targets.map((t) => `${t.account.name} (${ACCOUNT_KIND_LABELS[t.account.kind]})`).join(" · ")
                        : "Sin destinos todavía"}
                      {p.createdBy ? ` · por ${p.createdBy.name}` : ""}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <p className="sr-only">{POST_STATUSES.length} estados posibles</p>
    </>
  );
}
