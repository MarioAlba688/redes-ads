"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui";
import { NETWORK_LABELS, STATS_KINDS, STATS_RANGES, statsHref, type StatsFilters as Filters, type StatsKind } from "@/lib/stats/filters";

const segment = (active: boolean) =>
  `rounded-md px-3 py-1.5 transition-colors ${active ? "bg-primary/10 font-semibold text-primary" : "text-muted hover:text-foreground"}`;

export function StatsFilters({
  filters,
  sort,
  kinds,
  brands,
}: {
  filters: Filters;
  sort: string;
  /** Tipos de cuenta que tienen publicaciones (el filtro solo se ofrece si hay mas de uno). */
  kinds: StatsKind[];
  brands: { id: string; name: string }[];
}) {
  const router = useRouter();
  const withKind = (kind: StatsKind | null): Filters => ({ ...filters, kind });

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <div role="group" aria-label="Periodo" className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-sm">
        {STATS_RANGES.map((d) => (
          <Link key={d} href={statsHref({ ...filters, days: d }, sort)} aria-current={d === filters.days ? "true" : undefined} className={segment(d === filters.days)}>
            {d} días
          </Link>
        ))}
      </div>

      {kinds.length > 1 && (
        <div role="group" aria-label="Red social" className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-sm">
          {([null, ...STATS_KINDS] as (StatsKind | null)[]).map((k) => (
            <Link key={k ?? "todas"} href={statsHref(withKind(k), sort)} aria-current={k === filters.kind ? "true" : undefined} className={segment(k === filters.kind)}>
              {k ? NETWORK_LABELS[k] : "Todas"}
            </Link>
          ))}
        </div>
      )}

      {brands.length > 1 && (
        <div className="w-full sm:w-56">
          <Select
            aria-label="Marca"
            value={filters.brandId ?? ""}
            onChange={(e) => router.push(statsHref({ ...filters, brandId: e.target.value || null }, sort))}
            className="py-1.5"
          >
            <option value="">Todas las marcas</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}
