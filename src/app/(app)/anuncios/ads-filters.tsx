"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui";

const RANGES = [7, 30, 90] as const;

export function AdsFilters({
  days,
  accountId,
  accounts,
  platform,
  platforms,
}: {
  days: number;
  accountId: string | null;
  accounts: { id: string; name: string }[];
  /** Plataforma elegida (META, GOOGLE_ADS, TIKTOK) o null para todas. */
  platform: string | null;
  /** Plataformas con cuentas conectadas; el filtro solo se ofrece si hay mas de una. */
  platforms: { id: string; name: string }[];
}) {
  const router = useRouter();
  const href = (d: number, acc: string | null, plat: string | null) => {
    const q = new URLSearchParams({ dias: String(d) });
    if (plat) q.set("plataforma", plat);
    if (acc) q.set("cuenta", acc);
    return `/anuncios?${q.toString()}`;
  };

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3">
      <div role="group" aria-label="Periodo" className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-sm">
        {RANGES.map((d) => (
          <Link
            key={d}
            href={href(d, accountId, platform)}
            aria-current={d === days ? "true" : undefined}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              d === days ? "bg-primary/10 font-semibold text-primary" : "text-muted hover:text-foreground"
            }`}
          >
            {d} días
          </Link>
        ))}
      </div>

      {platforms.length > 1 && (
        <div role="group" aria-label="Plataforma" className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-sm">
          {[{ id: null, name: "Todas" }, ...platforms].map((p) => (
            <Link
              key={p.id ?? "todas"}
              // Al cambiar de plataforma se quita la cuenta elegida (puede ser de otra plataforma).
              href={href(days, null, p.id)}
              aria-current={p.id === platform ? "true" : undefined}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                p.id === platform ? "bg-primary/10 font-semibold text-primary" : "text-muted hover:text-foreground"
              }`}
            >
              {p.name}
            </Link>
          ))}
        </div>
      )}

      {accounts.length > 1 && (
        <div className="w-full sm:w-64">
          <Select
            aria-label="Cuenta publicitaria"
            value={accountId ?? ""}
            onChange={(e) => router.push(href(days, e.target.value || null, platform))}
            className="py-1.5"
          >
            <option value="">Todas las cuentas</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}
