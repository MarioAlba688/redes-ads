import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { dateTimeFormat } from "@/lib/display-time";
import { formatCompact, formatInt, formatPercent } from "@/lib/format";
import { missingStatsScopes } from "@/lib/meta/scopes";
import { can } from "@/lib/permissions";
import { NETWORK_LABELS, NETWORK_PARAM, parseStatsFilters, STATS_KINDS, statsHref, type StatsKind } from "@/lib/stats/filters";
import { engagementRate, interactions, isSortKey, SORT_KEYS, SORT_LABELS, sortRows, summarize, type PostMetrics, type Summary } from "@/lib/stats/metrics";
import { loadStatRows, STATS_ROW_LIMIT, type StatRow } from "@/lib/stats/query";
import { RefreshStatsButton } from "./refresh-button";
import { StatsFilters } from "./stats-filters";

export const metadata: Metadata = { title: "Estadísticas" };

/** Filas que se listan en la tabla de publicaciones (los resumenes cuentan todas las del periodo). */
const TABLE_ROWS = 50;
const TOP_BARS = 8;

const count = (v: number | null) => (v === null ? "—" : formatInt(v));
const compact = (v: number | null) => (v === null ? "—" : formatCompact(v));
const rateText = (v: number | null) => (v === null ? "—" : formatPercent(v, 1));
const excerpt = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}

function Num({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <td className="px-2.5 py-3 text-right" title={title}>
      {children}
    </td>
  );
}

// Columnas de cifras apretadas: con 8 columnas la tabla debe caber en el ancho de la pagina sin desplazarse.
const th = "px-2.5 py-2.5 text-right text-[11px] font-medium";

export default async function StatsPage({ searchParams }: PageProps<"/estadisticas">) {
  const user = await requireUser("metrics.view");
  const q = await searchParams;

  const [brands, accounts] = await Promise.all([
    db.brand.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.socialAccount.findMany({
      where: { platform: "META", kind: { in: [...STATS_KINDS] }, status: { not: "REVOKED" } },
      select: { name: true, kind: true, status: true, scopes: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const filters = parseStatsFilters({ dias: q.dias, marca: q.marca, red: q.red }, brands.map((b) => b.id));
  const sort = isSortKey(q.orden) ? q.orden : "interacciones";
  const rows = await loadStatRows(filters);
  const dateFmt = dateTimeFormat();
  const canRefresh = can(user.role, "stats.refresh");

  // --- avisos de conexion y permisos ---
  const expired = accounts.filter((a) => a.status === "EXPIRED");
  const lacking = accounts
    .filter((a) => a.status === "ACTIVE")
    .map((a) => ({ name: a.name, ...missingStatsScopes(a.kind, a.scopes) }));
  const noBasic = lacking.filter((a) => a.basic).map((a) => a.name);
  const noInsights = lacking.filter((a) => !a.basic && a.insights).map((a) => a.name);

  // --- resumenes ---
  const summary = summarize(rows);
  const kindsPresent = STATS_KINDS.filter((k) => rows.some((r) => r.kind === k));
  const brandsPresent = brands.filter((b) => rows.some((r) => r.brandId === b.id));
  const byInteractions = sortRows(rows, "interacciones");
  const best = byInteractions[0]?.metrics && interactions(byInteractions[0].metrics) ? byInteractions[0] : null;
  const bars = byInteractions.filter((r) => r.metrics && (interactions(r.metrics) ?? 0) > 0).slice(0, TOP_BARS);
  const maxBar = bars.length ? (interactions(bars[0].metrics as PostMetrics) as number) : 0;
  const listed = sortRows(rows, sort).slice(0, TABLE_ROWS);
  const hasAnyPublished = rows.length > 0;

  // El filtro de red solo tiene sentido si hay cuentas de las dos redes (no solo publicaciones en el periodo).
  const kindsConnected = STATS_KINDS.filter((k) => accounts.some((a) => a.kind === k));

  return (
    <>
      <PageHeader
        title="Estadísticas"
        description="Cómo les va a tus publicaciones de Facebook e Instagram. Se leen de cada red y se actualizan solas."
        action={canRefresh && hasAnyPublished ? <RefreshStatsButton days={filters.days} brandId={filters.brandId} network={filters.kind ? NETWORK_PARAM[filters.kind] : null} /> : undefined}
      />

      {expired.length > 0 && (
        <div className="mb-4">
          <Alert tone="warning">
            La conexión de {expired.map((a) => a.name).join(", ")} venció, así que sus cifras dejaron de actualizarse.{" "}
            <Link href="/cuentas" className="font-medium underline">
              Reconéctala en Cuentas
            </Link>
            .
          </Alert>
        </div>
      )}
      {noBasic.length > 0 && (
        <div className="mb-4">
          <Alert tone="warning">
            Estas cuentas no tienen el permiso para leer estadísticas (pages_read_engagement o instagram_basic), así que no se lee ninguna de sus cifras: {noBasic.join(", ")}.{" "}
            <Link href="/manual#estadisticas" className="font-medium underline">
              Ver cómo arreglarlo
            </Link>
            .
          </Alert>
        </div>
      )}
      {noInsights.length > 0 && (
        <div className="mb-4">
          <Alert tone="warning">
            Estas cuentas no tienen el permiso read_insights o instagram_manage_insights: se leen sus reacciones y comentarios, pero no las vistas ni el alcance: {noInsights.join(", ")}.{" "}
            <Link href="/manual#estadisticas" className="font-medium underline">
              Ver cómo arreglarlo
            </Link>
            .
          </Alert>
        </div>
      )}

      <StatsFilters filters={filters} sort={sort} kinds={kindsConnected as StatsKind[]} brands={brands.length > 1 ? brands : []} />

      {!hasAnyPublished ? (
        <Card className="mx-auto mt-6 max-w-lg p-8 text-center">
          <h2 className="text-lg font-semibold">Aún no hay publicaciones en este periodo</h2>
          <p className="mt-2 text-sm text-muted">
            Aquí aparecen las publicaciones que salieron en Facebook e Instagram desde la app, con sus vistas, alcance, reacciones, comentarios, compartidos y guardados. Prueba un periodo más largo o publica algo.
          </p>
          <Link href="/publicaciones" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
            Ir a Publicaciones
          </Link>
        </Card>
      ) : (
        <>
          {summary.measured === 0 && (
            <div className="mb-4">
              <Alert tone="success">
                Todavía no se leyó ninguna cifra: el proceso en segundo plano lo hace en unos minutos
                {canRefresh ? ", o pulsa «Actualizar» para leerlas ahora" : ""}.
              </Alert>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <Tile
              label="Publicaciones"
              value={formatInt(rows.length)}
              hint={summary.pending > 0 ? `${summary.measured} con cifras · ${summary.pending} por leer` : "todas con cifras"}
            />
            <Tile label="Vistas" value={compact(summary.views)} hint="veces que se mostraron, con repeticiones" />
            <Tile label="Alcance medio" value={compact(summary.avgReach === null ? null : Math.round(summary.avgReach))} hint="personas distintas por publicación" />
            <Tile
              label="Interacciones"
              value={compact(summary.interactions)}
              hint={[
                summary.likes !== null && `${formatInt(summary.likes)} reacciones`,
                summary.comments !== null && `${formatInt(summary.comments)} comentarios`,
                summary.shares !== null && `${formatInt(summary.shares)} compartidos`,
                summary.saves !== null && `${formatInt(summary.saves)} guardados`,
              ]
                .filter(Boolean)
                .join(" · ") || undefined}
            />
            <Tile label="Interacción por alcance" value={rateText(summary.rate)} hint="interacciones ÷ personas alcanzadas" />
            <Card className="p-4">
              <p className="text-sm text-muted">Mejor publicación</p>
              {best ? (
                <>
                  <Link href={`/publicaciones/${best.postId}`} className="mt-1 line-clamp-2 text-sm font-semibold hover:underline">
                    {excerpt(best.text, 90)}
                  </Link>
                  <p className="mt-1 text-xs text-muted">
                    {formatInt(interactions(best.metrics as PostMetrics) as number)} interacciones · {best.brandName}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-2xl font-semibold">—</p>
              )}
            </Card>
          </div>

          {bars.length > 0 && (
            <Card className="mt-4 p-5">
              <h2 className="font-semibold">Las que más interacciones tuvieron</h2>
              <p className="text-xs text-muted">Reacciones, comentarios, compartidos y guardados de cada publicación.</p>
              <ul className="mt-4 space-y-2.5">
                {bars.map((r) => {
                  const total = interactions(r.metrics as PostMetrics) as number;
                  return (
                    <li key={r.targetId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[14rem_minmax(0,1fr)_auto]">
                      <div className="flex min-w-0 items-baseline gap-1.5 sm:col-start-1">
                        <Link href={`/publicaciones/${r.postId}`} className="truncate text-sm hover:underline" title={r.text}>
                          {excerpt(r.text, 60)}
                        </Link>
                        <span className="shrink-0 text-xs text-muted">{NETWORK_LABELS[r.kind]}</span>
                      </div>
                      <span className="text-right text-sm font-medium tabular-nums sm:order-3">{formatInt(total)}</span>
                      <div className="col-span-2 h-2 overflow-hidden rounded-full bg-background sm:order-2 sm:col-span-1" aria-hidden="true">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max((total / maxBar) * 100, 2)}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          {kindsPresent.length > 1 && (
            <SummaryTable
              title="Por red social"
              note="Facebook e Instagram no miden igual: compáralas por separado."
              first="Red"
              groups={kindsPresent.map((k) => ({ key: k, label: NETWORK_LABELS[k], posts: rows.filter((r) => r.kind === k).length, s: summarize(rows.filter((r) => r.kind === k)) }))}
            />
          )}
          {brandsPresent.length > 1 && (
            <SummaryTable
              title="Por marca"
              first="Marca"
              groups={brandsPresent.map((b) => ({ key: b.id, label: b.name, posts: rows.filter((r) => r.brandId === b.id).length, s: summarize(rows.filter((r) => r.brandId === b.id)) }))}
            />
          )}

          <Card className="mt-4 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h2 className="font-semibold">Publicaciones</h2>
                <p className="text-xs text-muted">
                  {rows.length > TABLE_ROWS ? `Las ${TABLE_ROWS} primeras de ${rows.length}${rows.length >= STATS_ROW_LIMIT ? " (el tope por consulta)" : ""}.` : `${rows.length} en este periodo.`}
                </p>
              </div>
              <div role="group" aria-label="Ordenar por" className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-xs">
                {SORT_KEYS.map((k) => (
                  <Link
                    key={k}
                    href={statsHref(filters, k)}
                    aria-current={k === sort ? "true" : undefined}
                    className={`rounded-md px-2.5 py-1.5 transition-colors ${k === sort ? "bg-primary/10 font-semibold text-primary" : "text-muted hover:text-foreground"}`}
                  >
                    {SORT_LABELS[k]}
                  </Link>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table aria-label="Publicaciones con sus estadísticas" className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Publicación
                    </th>
                    <th scope="col" className={th}>Vistas</th>
                    <th scope="col" className={th}>Alcance</th>
                    <th scope="col" className={th}>Reacciones</th>
                    <th scope="col" className={th}>Comentarios</th>
                    <th scope="col" className={th}>Compartidos</th>
                    <th scope="col" className={th}>Guardados</th>
                    <th scope="col" className={th}>Interacción</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border tabular-nums">
                  {listed.map((r) => (
                    <PostRow key={r.targetId} row={r} dateFmt={dateFmt} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <details className="mt-4 rounded-xl border border-border bg-surface px-5 py-3 text-sm">
            <summary className="cursor-pointer font-medium">Qué significa cada cifra</summary>
            <dl className="mt-3 space-y-2 text-muted">
              <div>
                <dt className="inline font-medium text-foreground">Vistas: </dt>
                <dd className="inline">las veces que se mostró la publicación, contando repeticiones de la misma persona.</dd>
              </div>
              <div>
                <dt className="inline font-medium text-foreground">Alcance: </dt>
                <dd className="inline">personas distintas que la vieron. No se suma entre publicaciones (una persona puede ver varias), por eso arriba se muestra el medio.</dd>
              </div>
              <div>
                <dt className="inline font-medium text-foreground">Interacciones: </dt>
                <dd className="inline">reacciones («me gusta» en Instagram) + comentarios + compartidos + guardados. Los guardados solo existen en Instagram.</dd>
              </div>
              <div>
                <dt className="inline font-medium text-foreground">Interacción por alcance: </dt>
                <dd className="inline">interacciones ÷ personas alcanzadas, solo con las publicaciones que tienen ambas cifras.</dd>
              </div>
              <div>
                <dt className="inline font-medium text-foreground">Cuándo se actualizan: </dt>
                <dd className="inline">
                  cada 3 horas los primeros 2 días, cada 12 horas hasta las 2 semanas y una vez al día hasta los 90 días; después ya no se mueven.
                  {canRefresh ? " «Actualizar» las lee al momento (las 12 más recientes de lo que estás viendo)." : ""}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium text-foreground">«—»: </dt>
                <dd className="inline">la red no entregó esa cifra (no es lo mismo que 0). Las vistas y el alcance pueden tardar unas horas en aparecer.</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted">
              ¿Algo no cuadra?{" "}
              <Link href="/manual#estadisticas" className="font-medium text-primary hover:underline">
                Revisa el Manual
              </Link>
              .
            </p>
          </details>
        </>
      )}
    </>
  );
}

function SummaryTable({
  title,
  note,
  first,
  groups,
}: {
  title: string;
  note?: string;
  first: string;
  groups: { key: string; label: string; posts: number; s: Summary }[];
}) {
  return (
    <Card className="mt-4 overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <h2 className="font-semibold">{title}</h2>
        {note && <p className="text-xs text-muted">{note}</p>}
      </div>
      <div className="overflow-x-auto">
        <table aria-label={title} className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {first}
              </th>
              <th scope="col" className={th}>Publicaciones</th>
              <th scope="col" className={th}>Vistas</th>
              <th scope="col" className={th}>Alcance medio</th>
              <th scope="col" className={th}>Interacciones</th>
              <th scope="col" className={th}>Interacción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border tabular-nums">
            {groups.map((g) => (
              <tr key={g.key}>
                <th scope="row" className="px-4 py-3 font-sans font-medium">
                  {g.label}
                </th>
                <Num>{formatInt(g.posts)}</Num>
                <Num>{count(g.s.views)}</Num>
                <Num>{count(g.s.avgReach === null ? null : Math.round(g.s.avgReach))}</Num>
                <Num>{count(g.s.interactions)}</Num>
                <Num>{rateText(g.s.rate)}</Num>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PostRow({ row: r, dateFmt }: { row: StatRow; dateFmt: Intl.DateTimeFormat }) {
  const m = r.metrics;
  const rate = m ? engagementRate(m) : null;
  const unknown = "La red no entregó esta cifra";
  return (
    <tr className="align-top">
      <td className="px-4 py-3 font-sans">
        <div className="flex min-w-52 items-start gap-3">
          {r.imageUrl && (
            // Imagen dinamica servida por nuestra ruta /media: next/image no aporta nada aqui.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.imageUrl} alt="" className="size-10 shrink-0 rounded-md border border-border object-cover" />
          )}
          <div className="min-w-0">
            <Link href={`/publicaciones/${r.postId}`} className="line-clamp-2 font-medium hover:underline" title={r.text}>
              {excerpt(r.text, 120)}
            </Link>
            <p className="mt-0.5 text-xs text-muted">
              {r.brandName} · {NETWORK_LABELS[r.kind]} {r.accountName} · {dateFmt.format(r.publishedAt)}
              {r.externalUrl && (
                <>
                  {" · "}
                  <a href={r.externalUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    Ver en {NETWORK_LABELS[r.kind]}
                  </a>
                </>
              )}
            </p>
            {!m && (
              <p className="mt-1">
                <Badge>Aún sin leer</Badge>
              </p>
            )}
            {m && r.fetchedAt && <p className="mt-0.5 text-xs text-muted">Leída {dateFmt.format(r.fetchedAt)}</p>}
            {r.note && (
              <p className="mt-1 line-clamp-3 text-xs text-warning" title={r.note}>
                {r.note}
              </p>
            )}
          </div>
        </div>
      </td>
      <Num title={m && m.views === null ? unknown : undefined}>{count(m?.views ?? null)}</Num>
      <Num title={m && m.reach === null ? unknown : undefined}>{count(m?.reach ?? null)}</Num>
      <Num title={m && m.likes === null ? unknown : undefined}>{count(m?.likes ?? null)}</Num>
      <Num title={m && m.comments === null ? unknown : undefined}>{count(m?.comments ?? null)}</Num>
      <Num title={m && m.shares === null ? unknown : undefined}>{count(m?.shares ?? null)}</Num>
      <Num title={r.kind === "FACEBOOK_PAGE" ? "Facebook no tiene guardados" : m && m.saves === null ? unknown : undefined}>
        {r.kind === "FACEBOOK_PAGE" ? <span className="text-muted">n/a</span> : count(m?.saves ?? null)}
      </Num>
      <Num>{rateText(rate)}</Num>
    </tr>
  );
}
