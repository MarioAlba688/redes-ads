import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Card, PageHeader } from "@/components/ui";
import { SpendChart } from "@/components/spend-chart";
import { requireUser } from "@/lib/auth/dal";
import { dateTimeFormat } from "@/lib/display-time";
import { db } from "@/lib/db";
import { formatCompact, formatDelta, formatInt, formatMoney, formatPercent } from "@/lib/format";
import { addDays, fromDbDate, toDbDate, todayInTimezone } from "@/lib/meta/dates";
import {
  buildReport,
  cpc,
  cpm,
  ctr,
  percentChange,
  type CurrencyReport,
  type Totals,
} from "@/lib/meta/report";
import { can } from "@/lib/permissions";
import { ADS_PLATFORM_IDS, isAdsPlatform, PLATFORM_NAMES, type PlatformId } from "@/lib/platforms";
import { SyncAllButton } from "../cuentas/account-controls";
import { AdsFilters } from "./ads-filters";

export const metadata: Metadata = { title: "Anuncios" };

const RANGES = [7, 30, 90];
const TOP_CAMPAIGNS = 15;

type Tone = "neutral" | "good" | "bad";

/** Tarjeta de una cifra con su variacion contra el periodo anterior (flecha + signo, no solo color). */
function StatTile({
  label,
  value,
  current,
  previous,
  better,
}: {
  label: string;
  value: string;
  current: number | null;
  previous: number | null;
  /** Que direccion es "buena" para esta cifra; "none" si subir o bajar no es ni bueno ni malo. */
  better: "up" | "down" | "none";
}) {
  const change = percentChange(current, previous);
  // Un cambio que se redondea a 0,0 % se muestra como "sin cambio": no es ni subida ni bajada.
  const flat = change !== null && Math.abs(change) < 0.0005;
  let tone: Tone = "neutral";
  if (change !== null && !flat && better !== "none") {
    tone = (change > 0) === (better === "up") ? "good" : "bad";
  }
  const toneClass = { neutral: "text-muted", good: "text-success", bad: "text-danger" }[tone];

  return (
    <Card className="p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {change !== null && (
        <p className={`mt-1 text-xs ${toneClass}`}>
          <span aria-hidden="true">{flat ? "•" : change > 0 ? "▲" : "▼"}</span>{" "}
          {flat ? "Sin cambio" : formatDelta(change)} <span className="text-muted">vs. periodo anterior</span>
        </p>
      )}
    </Card>
  );
}

function CurrencySection({ report, showHeading }: { report: CurrencyReport; showHeading: boolean }) {
  const { currency, totals, previous } = report;
  const money = (v: number | null) => (v === null ? "—" : formatMoney(v, currency));
  const prev: Totals | null = previous;

  return (
    <section className="mb-10">
      {showHeading && <h2 className="mb-3 text-lg font-semibold">Cuentas en {currency}</h2>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile label="Gasto" value={money(totals.spend)} current={totals.spend} previous={prev?.spend ?? null} better="none" />
        <StatTile label="Impresiones" value={formatCompact(totals.impressions)} current={totals.impressions} previous={prev?.impressions ?? null} better="none" />
        <StatTile label="Clics" value={formatCompact(totals.clicks)} current={totals.clicks} previous={prev?.clicks ?? null} better="none" />
        <StatTile label="CTR (clics / impresiones)" value={ctr(totals) === null ? "—" : formatPercent(ctr(totals)!)} current={ctr(totals)} previous={prev ? ctr(prev) : null} better="up" />
        <StatTile label="Costo por clic" value={money(cpc(totals))} current={cpc(totals)} previous={prev ? cpc(prev) : null} better="down" />
        <StatTile label="Costo por mil impresiones" value={money(cpm(totals))} current={cpm(totals)} previous={prev ? cpm(prev) : null} better="down" />
      </div>

      <Card className="mt-4 p-5">
        <SpendChart data={report.daily} currency={currency} title="Gasto diario" />
      </Card>

      {report.platforms.length > 1 && (
        <Card className="mt-4 overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <h3 className="font-semibold">Por plataforma</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Plataforma</th>
                  <th className="px-5 py-2.5 text-right font-medium">Gasto</th>
                  <th className="px-5 py-2.5 text-right font-medium">Impresiones</th>
                  <th className="px-5 py-2.5 text-right font-medium">Clics</th>
                  <th className="px-5 py-2.5 text-right font-medium">CTR</th>
                  <th className="px-5 py-2.5 text-right font-medium">CPC</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border tabular-nums">
                {report.platforms.map((p) => (
                  <tr key={p.platform}>
                    <td className="px-5 py-3 font-sans font-medium">{PLATFORM_NAMES[p.platform as PlatformId] ?? p.platform}</td>
                    <td className="px-5 py-3 text-right">{money(p.totals.spend)}</td>
                    <td className="px-5 py-3 text-right">{formatInt(p.totals.impressions)}</td>
                    <td className="px-5 py-3 text-right">{formatInt(p.totals.clicks)}</td>
                    <td className="px-5 py-3 text-right">{ctr(p.totals) === null ? "—" : formatPercent(ctr(p.totals)!)}</td>
                    <td className="px-5 py-3 text-right">{money(cpc(p.totals))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="mt-4 overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h3 className="font-semibold">Campañas</h3>
          <p className="text-xs text-muted">
            {report.campaigns.length > TOP_CAMPAIGNS
              ? `Las ${TOP_CAMPAIGNS} con más gasto, de ${report.campaigns.length}.`
              : "Ordenadas por gasto."}
          </p>
        </div>
        {report.campaigns.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">Ninguna campaña tuvo actividad en este periodo.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Campaña</th>
                  <th className="px-5 py-2.5 text-right font-medium">Gasto</th>
                  <th className="px-5 py-2.5 text-right font-medium">Impresiones</th>
                  <th className="px-5 py-2.5 text-right font-medium">Clics</th>
                  <th className="px-5 py-2.5 text-right font-medium">CTR</th>
                  <th className="px-5 py-2.5 text-right font-medium">CPC</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border tabular-nums">
                {report.campaigns.slice(0, TOP_CAMPAIGNS).map((c) => (
                  <tr key={`${c.accountName}|${c.campaignId}`}>
                    <td className="px-5 py-3 font-sans">
                      <p className="font-medium">{c.campaignName}</p>
                      <p className="text-xs text-muted">
                        {c.accountName}
                        {c.platform ? ` · ${PLATFORM_NAMES[c.platform as PlatformId] ?? c.platform}` : ""}
                      </p>
                    </td>
                    <td className="px-5 py-3 text-right">{money(c.totals.spend)}</td>
                    <td className="px-5 py-3 text-right">{formatInt(c.totals.impressions)}</td>
                    <td className="px-5 py-3 text-right">{formatInt(c.totals.clicks)}</td>
                    <td className="px-5 py-3 text-right">{ctr(c.totals) === null ? "—" : formatPercent(ctr(c.totals)!)}</td>
                    <td className="px-5 py-3 text-right">{money(cpc(c.totals))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {report.accounts.length > 1 && (
        <Card className="mt-4 overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <h3 className="font-semibold">Por cuenta publicitaria</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Cuenta</th>
                  <th className="px-5 py-2.5 text-right font-medium">Gasto</th>
                  <th className="px-5 py-2.5 text-right font-medium">Impresiones</th>
                  <th className="px-5 py-2.5 text-right font-medium">Clics</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border tabular-nums">
                {report.accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="px-5 py-3 font-sans">
                      <p className="font-medium">{a.name}</p>
                      {a.platform && <p className="text-xs text-muted">{PLATFORM_NAMES[a.platform as PlatformId] ?? a.platform}</p>}
                    </td>
                    <td className="px-5 py-3 text-right">{money(a.totals.spend)}</td>
                    <td className="px-5 py-3 text-right">{formatInt(a.totals.impressions)}</td>
                    <td className="px-5 py-3 text-right">{formatInt(a.totals.clicks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </section>
  );
}

export default async function AdsPage({ searchParams }: PageProps<"/anuncios">) {
  const user = await requireUser("metrics.view");
  const q = await searchParams;

  const requestedDays = Number(typeof q.dias === "string" ? q.dias : "");
  const days = RANGES.includes(requestedDays) ? requestedDays : 30;

  const allAccounts = await db.socialAccount.findMany({
    where: { platform: { in: [...ADS_PLATFORM_IDS] }, kind: "AD_ACCOUNT" },
    select: { id: true, name: true, platform: true, currency: true, timezone: true, status: true, lastSyncedAt: true, lastError: true },
    orderBy: [{ platform: "asc" }, { name: "asc" }],
  });
  // Plataformas con cuentas conectadas (solo se ofrece filtrar si hay mas de una).
  const platformsWithAccounts = ADS_PLATFORM_IDS.filter((p) => allAccounts.some((a) => a.platform === p));
  const requestedPlatform = typeof q.plataforma === "string" ? q.plataforma : null;
  const platform = requestedPlatform && isAdsPlatform(requestedPlatform) && platformsWithAccounts.includes(requestedPlatform) ? requestedPlatform : null;
  const accounts = platform ? allAccounts.filter((a) => a.platform === platform) : allAccounts;
  const requestedAccount = typeof q.cuenta === "string" ? q.cuenta : null;
  const accountId = accounts.some((a) => a.id === requestedAccount) ? requestedAccount : null;
  const scope = accountId ? accounts.filter((a) => a.id === accountId) : accounts;

  // El periodo termina "hoy" en la zona horaria de las cuentas (las fechas de Meta van en esa zona;
  // con zonas distintas, la mas adelantada). El periodo anterior de igual duracion sirve para comparar.
  const todays = scope.map((a) => todayInTimezone(a.timezone));
  const until = todays.length ? todays.reduce((a, b) => (a > b ? a : b)) : todayInTimezone("UTC");
  const since = addDays(until, -(days - 1));
  const prevSince = addDays(since, -days);

  const rows = scope.length
    ? await db.adInsightDaily.findMany({
        where: {
          accountId: { in: scope.map((a) => a.id) },
          date: { gte: toDbDate(prevSince), lte: toDbDate(until) },
        },
        select: {
          accountId: true,
          date: true,
          campaignId: true,
          campaignName: true,
          spend: true,
          impressions: true,
          clicks: true,
        },
        orderBy: { date: "asc" },
      })
    : [];

  const reports = buildReport({
    accounts: scope.map((a) => ({ id: a.id, name: a.name, currency: a.currency, platform: a.platform })),
    rows: rows.map((r) => ({
      accountId: r.accountId,
      date: fromDbDate(r.date),
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      spend: r.spend.toNumber(),
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
    })),
    since,
    until,
  });

  const canManage = can(user.role, "accounts.manage");
  const expired = accounts.filter((a) => a.status === "EXPIRED");
  const errored = accounts.filter((a) => a.status === "ACTIVE" && a.lastError);
  const lastSync = scope.reduce<Date | null>((latest, a) => (a.lastSyncedAt && (!latest || a.lastSyncedAt > latest) ? a.lastSyncedAt : latest), null);
  const hasData = rows.length > 0;
  const platformNames = platformsWithAccounts.length ? platformsWithAccounts.map((p) => PLATFORM_NAMES[p]).join(", ") : "Meta, Google Ads y TikTok";
  const dateFmt = dateTimeFormat();

  return (
    <>
      <PageHeader
        title="Anuncios"
        description={
          lastSync
            ? `Rendimiento de tus cuentas publicitarias de ${platformNames}. Última sincronización: ${dateFmt.format(lastSync)}.`
            : `Rendimiento de tus cuentas publicitarias de ${platformNames}.`
        }
        action={canManage && allAccounts.length > 0 ? <SyncAllButton /> : undefined}
      />

      {expired.length > 0 && (
        <div className="mb-4">
          <Alert tone="warning">
            La conexión de {expired.map((a) => `${a.name} (${PLATFORM_NAMES[a.platform as PlatformId]})`).join(", ")} venció.{" "}
            <Link href="/cuentas" className="font-medium underline">
              Reconéctala en Cuentas
            </Link>{" "}
            para seguir actualizando los datos.
          </Alert>
        </div>
      )}
      {errored.length > 0 && (
        <div className="mb-4">
          <Alert tone="danger">
            La última sincronización de {errored.map((a) => `${a.name} (${PLATFORM_NAMES[a.platform as PlatformId]})`).join(", ")} falló. Detalle en{" "}
            <Link href="/cuentas" className="font-medium underline">
              Cuentas
            </Link>
            .
          </Alert>
        </div>
      )}

      {allAccounts.length === 0 ? (
        <Card className="mx-auto mt-6 max-w-lg p-8 text-center">
          <h2 className="text-lg font-semibold">Aún no hay cuentas publicitarias</h2>
          <p className="mt-2 text-sm text-muted">
            Conecta Meta, Google Ads o TikTok Ads para ver aquí el gasto, las impresiones y los clics de tus campañas.
          </p>
          <Link href="/cuentas" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
            Ir a Cuentas
          </Link>
        </Card>
      ) : (
        <>
          <AdsFilters
            days={days}
            accountId={accountId}
            accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
            platform={platform}
            platforms={platformsWithAccounts.map((p) => ({ id: p, name: PLATFORM_NAMES[p] }))}
          />
          {!hasData ? (
            <Card className="p-8 text-center">
              <h2 className="text-lg font-semibold">Sin datos en este periodo</h2>
              <p className="mt-2 text-sm text-muted">
                {lastSync
                  ? "Las cuentas se sincronizaron pero no tuvieron gasto en estas fechas. Prueba un periodo más largo."
                  : "Todavía no se descargó el rendimiento. Pulsa «Sincronizar todas» para traer los últimos 30 días."}
              </p>
            </Card>
          ) : (
            reports.map((r) => <CurrencySection key={r.currency} report={r} showHeading={reports.length > 1} />)
          )}
        </>
      )}
    </>
  );
}
