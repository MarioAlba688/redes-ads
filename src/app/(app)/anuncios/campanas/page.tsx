import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import { can } from "@/lib/permissions";
import { fromMinorUnits } from "@/lib/promotions/currency";
import { budgetHolder } from "@/lib/promotions/existing";
import { loadExisting } from "@/lib/promotions/manage";
import { effectiveStatusLabel, effectiveStatusTone } from "@/lib/promotions/types";
import { ExistingRowActions } from "./existing-actions";

export const metadata: Metadata = { title: "Campañas en Meta" };

export default async function CampaignsPage({ searchParams }: PageProps<"/anuncios/campanas">) {
  const user = await requireUser("metrics.view");
  const q = await searchParams;
  const canPause = can(user.role, "ads.create") || can(user.role, "ads.approve");
  const canApprove = can(user.role, "ads.approve");

  const accounts = await db.socialAccount.findMany({
    where: { platform: "META", kind: "AD_ACCOUNT", status: { not: "REVOKED" } },
    select: { id: true, name: true, currency: true, status: true, dailyBudgetCap: true },
    orderBy: { name: "asc" },
  });
  const requested = typeof q.cuenta === "string" ? q.cuenta : null;
  const account = accounts.find((a) => a.id === requested) ?? accounts.find((a) => a.status === "ACTIVE") ?? accounts[0] ?? null;

  const header = <PageHeader title="Campañas en Meta" description="Lo que hay hoy en tu cuenta publicitaria, leído de Meta al abrir esta página: pausar, activar y cambiar el presupuesto diario." />;

  if (!account) {
    return (
      <>
        {header}
        <Card className="mx-auto mt-6 max-w-lg p-8 text-center">
          <h2 className="text-lg font-semibold">Aún no hay cuentas publicitarias de Meta</h2>
          <p className="mt-2 text-sm text-muted">Conecta Meta para ver y administrar tus campañas.</p>
          <Link href="/cuentas" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
            Ir a Cuentas
          </Link>
        </Card>
      </>
    );
  }

  const view = await loadExisting(account.id, { write: false });
  const cap = account.dailyBudgetCap === null ? null : Number(account.dailyBudgetCap);
  const currency = account.currency ?? "";

  // Campañas que se crearon desde esta app: se administran en su ficha, no aqui (para que el estado no se desfase).
  const own = view.ok
    ? await db.adPromotion.findMany({
        where: { adAccountId: account.id, metaCampaignId: { in: view.objects.campaigns.map((c) => c.id) }, status: { not: "FAILED" } },
        select: { id: true, metaCampaignId: true },
      })
    : [];
  const ownByCampaign = new Map(own.map((o) => [o.metaCampaignId as string, o.id]));

  const money = (minor: number | null) => {
    const v = fromMinorUnits(minor, currency);
    return v === null ? null : formatMoney(v, currency);
  };

  return (
    <>
      {header}

      {accounts.length > 1 && (
        <div role="group" aria-label="Cuenta publicitaria" className="mb-4 inline-flex flex-wrap rounded-lg border border-border bg-surface p-0.5 text-sm">
          {accounts.map((a) => (
            <Link
              key={a.id}
              href={`/anuncios/campanas?cuenta=${a.id}`}
              aria-current={a.id === account.id ? "true" : undefined}
              className={`rounded-md px-3 py-1.5 transition-colors ${a.id === account.id ? "bg-primary/10 font-semibold text-primary" : "text-muted hover:text-foreground"}`}
            >
              {a.name}
            </Link>
          ))}
        </div>
      )}

      {canApprove && cap === null && (
        <div className="mb-4">
          <Alert tone="warning">
            Esta cuenta no tiene un tope de gasto diario: no se puede activar nada ni cambiar presupuestos hasta que el administrador lo fije en{" "}
            <Link href="/cuentas" className="font-medium underline">
              Cuentas
            </Link>
            .
          </Alert>
        </div>
      )}

      {!view.ok ? (
        <Alert>
          {view.error}{" "}
          <Link href="/manual#anuncios" className="font-medium underline">
            Ver el Manual
          </Link>
        </Alert>
      ) : view.objects.campaigns.length === 0 ? (
        <Card className="p-8 text-center">
          <h2 className="text-lg font-semibold">Esta cuenta no tiene campañas</h2>
          <p className="mt-2 text-sm text-muted">Las que se creen en Meta o desde esta app aparecen aquí.</p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Nombre</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Estado en Meta</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">Presupuesto</th>
                  {/* aria-label y no un <span class="sr-only">: un elemento absoluto escapa del recorte de la tabla y ensancha toda la pagina en el movil. */}
                  <th scope="col" aria-label="Acciones" className="px-5 py-2.5 text-right font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {view.objects.campaigns.flatMap((c) => {
                  const ownId = ownByCampaign.get(c.id);
                  const sets = view.objects.adSets.filter((s) => s.campaignId === c.id);
                  const rows: React.ReactNode[] = [];

                  const budgetCell = (daily: number | null, lifetime: number | null) =>
                    daily ? `${money(daily) ?? daily} por día` : lifetime ? `${money(lifetime) ?? lifetime} en total` : "—";

                  const actionsFor = (level: "campaign" | "adset" | "ad", id: string, status: string | null) => {
                    if (ownId) return null;
                    const holder = level === "ad" ? null : budgetHolder(view.objects, level, id);
                    const budgetMinor = holder && !("reason" in holder) ? holder.dailyMinor : null;
                    return (
                      <ExistingRowActions
                        adAccountId={account.id}
                        level={level}
                        objectId={id}
                        status={status}
                        canPause={canPause}
                        canActivate={canApprove && cap !== null}
                        budget={budgetMinor === null ? null : fromMinorUnits(budgetMinor, currency)}
                        currency={currency}
                        cap={cap}
                      />
                    );
                  };

                  rows.push(
                    <tr key={`c-${c.id}`} className="bg-background/40">
                      <td className="px-5 py-3">
                        <p className="font-semibold">{c.name ?? c.id}</p>
                        <p className="text-xs text-muted">Campaña{c.objective ? ` · ${c.objective.replace("OUTCOME_", "").toLowerCase()}` : ""}</p>
                        {ownId && (
                          <Link href={`/anuncios/creados/${ownId}`} className="text-xs font-medium text-primary hover:underline">
                            Creado en la app — administrarlo en su ficha
                          </Link>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={effectiveStatusTone(c.effectiveStatus)}>{effectiveStatusLabel(c.effectiveStatus)}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums">{budgetCell(c.dailyBudgetMinor, c.lifetimeBudgetMinor)}</td>
                      <td className="px-5 py-3 text-right">{actionsFor("campaign", c.id, c.status)}</td>
                    </tr>,
                  );
                  for (const s of sets) {
                    rows.push(
                      <tr key={`s-${s.id}`}>
                        <td className="py-3 pl-10 pr-5">
                          <p className="font-medium">{s.name ?? s.id}</p>
                          <p className="text-xs text-muted">Conjunto de anuncios</p>
                        </td>
                        <td className="px-5 py-3">
                          <Badge tone={effectiveStatusTone(s.effectiveStatus)}>{effectiveStatusLabel(s.effectiveStatus)}</Badge>
                        </td>
                        <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums">{budgetCell(s.dailyBudgetMinor, s.lifetimeBudgetMinor)}</td>
                        <td className="px-5 py-3 text-right">{actionsFor("adset", s.id, s.status)}</td>
                      </tr>,
                    );
                    for (const a of view.objects.ads.filter((x) => x.adSetId === s.id)) {
                      rows.push(
                        <tr key={`a-${a.id}`}>
                          <td className="py-3 pl-16 pr-5">
                            <p>{a.name ?? a.id}</p>
                            <p className="text-xs text-muted">Anuncio</p>
                          </td>
                          <td className="px-5 py-3">
                            <Badge tone={effectiveStatusTone(a.effectiveStatus)}>{effectiveStatusLabel(a.effectiveStatus)}</Badge>
                          </td>
                          <td className="px-5 py-3" />
                          <td className="px-5 py-3 text-right">{actionsFor("ad", a.id, a.status)}</td>
                        </tr>,
                      );
                    }
                  }
                  return rows;
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {view.ok && view.objects.truncated && <p className="mt-3 text-xs text-muted">La cuenta tiene muchos objetos: solo se leen los primeros 300 de cada tipo.</p>}
      {view.ok && (
        <p className="mt-3 max-w-3xl text-xs text-muted">
          Activar solo se permite si el gasto diario cabe en el tope de la cuenta{cap !== null ? ` (${formatMoney(cap, currency)})` : ""}. Las campañas con presupuesto total (no diario) se administran directamente en Meta.
        </p>
      )}
    </>
  );
}
