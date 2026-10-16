import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { addDays, todayInTimezone } from "@/lib/meta/dates";
import { POST_STATUS_LABELS, POST_STATUS_TONES, type PostStatusName } from "@/lib/posts";
import { formatLocalInput } from "@/lib/time";
import { PostsViewTabs } from "../posts-tabs";

export const metadata: Metadata = { title: "Calendario" };

const WEEKDAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const DOT: Record<string, string> = {
  neutral: "bg-muted",
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

const monthKey = (d: string) => d.slice(0, 7);

/** "2026-10" -> primer dia del mes mostrado y cantidad de dias. */
function monthInfo(month: string) {
  const [y, m] = month.split("-").map(Number);
  const first = `${month}-01`;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // getUTCDay: 0 = domingo; la semana empieza en lunes
  const offset = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  return { first, days, offset };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function CalendarPage({ searchParams }: PageProps<"/publicaciones/calendario">) {
  await requireUser("content.view");
  const q = await searchParams;

  const brands = await db.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, timezone: true } });
  const brandId = typeof q.marca === "string" && brands.some((b) => b.id === q.marca) ? q.marca : null;
  const referenceTz = brands.find((b) => b.id === brandId)?.timezone ?? brands[0]?.timezone ?? "UTC";
  const today = todayInTimezone(referenceTz);
  const month = typeof q.mes === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(q.mes) ? q.mes : monthKey(today);
  const { first, days, offset } = monthInfo(month);

  // Margen de un dia a cada lado: el dia que cuenta es el de la zona horaria de cada marca, no el UTC.
  const from = new Date(`${addDays(first, -1)}T00:00:00Z`);
  const to = new Date(`${addDays(`${month}-${String(days).padStart(2, "0")}`, 2)}T00:00:00Z`);
  const posts = await db.post.findMany({
    where: {
      ...(brandId ? { brandId } : {}),
      OR: [{ scheduledAt: { gte: from, lt: to } }, { publishedAt: { gte: from, lt: to } }],
    },
    select: {
      id: true,
      text: true,
      status: true,
      scheduledAt: true,
      publishedAt: true,
      brand: { select: { name: true, timezone: true } },
    },
    orderBy: { scheduledAt: "asc" },
  });
  const unscheduled = await db.post.findMany({
    where: { status: "APPROVED", ...(brandId ? { brandId } : {}) },
    select: { id: true, text: true, brand: { select: { name: true } } },
    orderBy: { updatedAt: "desc" },
    take: 10,
  });

  // Cada publicacion va en el dia (de su marca) en que sale o salio.
  type Item = { id: string; time: string; text: string; status: PostStatusName; brand: string };
  const byDay = new Map<string, Item[]>();
  for (const p of posts) {
    const status = p.status as PostStatusName;
    const when = (status === "PUBLISHED" || status === "PARTIAL" ? p.publishedAt : p.scheduledAt) ?? p.scheduledAt ?? p.publishedAt;
    if (!when) continue;
    const local = formatLocalInput(when, p.brand.timezone); // "2026-10-16T09:00"
    const day = local.slice(0, 10);
    if (monthKey(day) !== month) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), { id: p.id, time: local.slice(11), text: p.text, status, brand: p.brand.name }]);
  }
  for (const list of byDay.values()) list.sort((a, b) => a.time.localeCompare(b.time));

  // Solo la primera letra en mayuscula ("Noviembre de 2026"); la clase "capitalize" de CSS pondria "De" tambien.
  const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const monthLabel = upperFirst(new Intl.DateTimeFormat("es", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${first}T00:00:00Z`)));
  const href = (m: string, brand = brandId) => `/publicaciones/calendario?mes=${m}${brand ? `&marca=${brand}` : ""}`;
  const cells: (string | null)[] = [
    ...Array<null>(offset).fill(null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  // En la cuadricula la celda es angosta: la marca va en el tooltip. En la agenda del movil hay espacio y se muestra.
  const chip = (it: Item, withBrand: boolean) => (
    <Link
      key={it.id}
      href={`/publicaciones/${it.id}`}
      title={`${it.brand} · ${POST_STATUS_LABELS[it.status]}`}
      className="block rounded px-1.5 py-1 text-xs hover:bg-background"
    >
      <span className="flex items-center gap-1.5 text-muted">
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${DOT[POST_STATUS_TONES[it.status]]}`} />
        <span className="tabular-nums">{it.time}</span>
        {withBrand && <span className="truncate">· {it.brand}</span>}
      </span>
      <span className="line-clamp-2 break-words">{it.text.replace(/\s+/g, " ")}</span>
      <span className="sr-only"> ({POST_STATUS_LABELS[it.status]})</span>
    </Link>
  );

  return (
    <>
      <PageHeader title="Publicaciones" description="Lo que sale cada día. La hora es la de la zona horaria de cada marca." action={<PostsViewTabs active="calendario" />} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface p-0.5 text-sm">
          <Link href={href(shiftMonth(month, -1))} aria-label="Mes anterior" className="rounded-md px-2.5 py-1.5 text-muted hover:text-foreground">
            ←
          </Link>
          <span className="min-w-36 text-center font-semibold">{monthLabel}</span>
          <Link href={href(shiftMonth(month, 1))} aria-label="Mes siguiente" className="rounded-md px-2.5 py-1.5 text-muted hover:text-foreground">
            →
          </Link>
        </div>
        <Link href={href(monthKey(today))} className="text-sm text-primary hover:underline">
          Hoy
        </Link>
        {brands.length > 1 && (
          <nav aria-label="Marca" className="ml-auto flex flex-wrap gap-2">
            {[{ id: null, name: "Todas" }, ...brands].map((b) => (
              <Link
                key={b.id ?? "todas"}
                href={href(month, b.id)}
                aria-current={b.id === brandId ? "true" : undefined}
                className={`rounded-full border px-3 py-1 text-sm ${
                  b.id === brandId ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-muted hover:text-foreground"
                }`}
              >
                {b.name}
              </Link>
            ))}
          </nav>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
        <div>
          {/* Cuadricula en pantallas anchas */}
          <Card className="hidden overflow-hidden md:block">
            <div className="grid grid-cols-7 border-b border-border bg-background text-center text-xs font-medium uppercase tracking-wide text-muted">
              {WEEKDAYS.map((d) => (
                <div key={d} className="py-2">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((day, i) => {
                const items = day ? (byDay.get(day) ?? []) : [];
                return (
                  <div key={i} className={`min-h-28 border-b border-r border-border p-1.5 ${day ? "" : "bg-background/60"}`}>
                    {day && (
                      <>
                        <p className={`mb-1 text-xs tabular-nums ${day === today ? "inline-flex size-5 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground" : "text-muted"}`}>
                          {Number(day.slice(8))}
                        </p>
                        <div className="space-y-0.5">
                          {items.slice(0, 3).map((it) => chip(it, false))}
                          {items.length > 3 && <p className="px-1.5 text-xs text-muted">+{items.length - 3} más</p>}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Agenda en pantallas pequeñas: solo los dias con publicaciones */}
          <div className="space-y-3 md:hidden">
            {[...byDay.keys()].sort().map((day) => (
              <Card key={day} className="p-3">
                <p className="mb-1 text-sm font-semibold">
                  {upperFirst(new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)))}
                </p>
                <div className="space-y-0.5">{byDay.get(day)!.map((it) => chip(it, true))}</div>
              </Card>
            ))}
            {byDay.size === 0 && <p className="py-6 text-center text-sm text-muted">No hay publicaciones este mes.</p>}
          </div>
        </div>

        <aside>
          <Card className="p-4">
            <h2 className="mb-2 text-sm font-semibold">Aprobadas sin fecha</h2>
            {unscheduled.length === 0 ? (
              <p className="text-sm text-muted">No hay ninguna esperando fecha.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {unscheduled.map((u) => (
                  <li key={u.id}>
                    <Link href={`/publicaciones/${u.id}`} className="block rounded px-1.5 py-1 hover:bg-background">
                      <Badge tone="primary">{u.brand.name}</Badge>
                      <span className="mt-1 line-clamp-2 block">{u.text}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}
