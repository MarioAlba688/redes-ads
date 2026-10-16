import { addDays } from "@/lib/meta/dates";

// Logica pura de agregacion del informe de anuncios (sin base de datos, para poder probarla).

export type ReportRow = {
  accountId: string;
  /** AAAA-MM-DD */
  date: string;
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
};

export type ReportAccount = {
  id: string;
  name: string;
  currency: string | null;
  /** META, GOOGLE_ADS, TIKTOK. Sirve para desglosar por plataforma; sin el, todo cuenta como una sola. */
  platform?: string;
};

export type Totals = { spend: number; impressions: number; clicks: number };

export type CurrencyReport = {
  /** Codigo de moneda (USD, COP...). Las monedas distintas nunca se suman entre si. */
  currency: string;
  totals: Totals;
  /** Totales del periodo anterior de igual duracion; null si no hay datos de ese periodo. */
  previous: Totals | null;
  /** Un punto por dia del periodo (los dias sin gasto cuentan como 0). */
  daily: { date: string; spend: number }[];
  campaigns: { campaignId: string; campaignName: string; accountName: string; platform?: string; totals: Totals }[];
  accounts: { id: string; name: string; platform?: string; totals: Totals }[];
  /** Totales por plataforma (de mayor a menor gasto). Solo tiene sentido mostrarlo si hay mas de una. */
  platforms: { platform: string; totals: Totals }[];
};

export const emptyTotals = (): Totals => ({ spend: 0, impressions: 0, clicks: 0 });

function add(t: Totals, r: Pick<ReportRow, "spend" | "impressions" | "clicks">) {
  t.spend += r.spend;
  t.impressions += r.impressions;
  t.clicks += r.clicks;
}

/** Clics / impresiones. null si no hay impresiones. */
export const ctr = (t: Totals) => (t.impressions > 0 ? t.clicks / t.impressions : null);
/** Costo por clic. */
export const cpc = (t: Totals) => (t.clicks > 0 ? t.spend / t.clicks : null);
/** Costo por mil impresiones. */
export const cpm = (t: Totals) => (t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null);

/** Cambio porcentual de `current` respecto a `previous`; null si no se puede calcular. */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}

export function listDates(since: string, until: string): string[] {
  const out: string[] = [];
  for (let d = since; d <= until; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Agrupa las filas por moneda de la cuenta y calcula totales, serie diaria, campañas y cuentas.
 * `rows` puede incluir el periodo anterior (para la comparacion): se separa por fecha.
 */
export function buildReport(args: {
  accounts: ReportAccount[];
  rows: ReportRow[];
  since: string;
  until: string;
}): CurrencyReport[] {
  const { accounts, rows, since, until } = args;
  const days = listDates(since, until).length;
  const prevUntil = addDays(since, -1);
  const prevSince = addDays(prevUntil, -(days - 1));

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const currencyOf = (id: string) => accountById.get(id)?.currency ?? "N/D";

  const currencies = [...new Set(accounts.map((a) => a.currency ?? "N/D"))].sort();
  return currencies.map((currency) => {
    const totals = emptyTotals();
    const previousTotals = emptyTotals();
    let hasPrevious = false;
    const dailyMap = new Map(listDates(since, until).map((d) => [d, 0]));
    const campaigns = new Map<string, CurrencyReport["campaigns"][number]>();
    const perAccount = new Map(
      accounts.filter((a) => (a.currency ?? "N/D") === currency).map((a) => [a.id, emptyTotals()]),
    );
    const perPlatform = new Map<string, Totals>();

    for (const r of rows) {
      if (currencyOf(r.accountId) !== currency) continue;
      if (r.date >= since && r.date <= until) {
        add(totals, r);
        const platform = accountById.get(r.accountId)?.platform ?? "N/D";
        if (!perPlatform.has(platform)) perPlatform.set(platform, emptyTotals());
        add(perPlatform.get(platform)!, r);
        dailyMap.set(r.date, (dailyMap.get(r.date) ?? 0) + r.spend);
        const key = `${r.accountId}|${r.campaignId}`;
        let c = campaigns.get(key);
        if (!c) {
          c = {
            campaignId: r.campaignId,
            campaignName: r.campaignName,
            accountName: accountById.get(r.accountId)?.name ?? r.accountId,
            platform: accountById.get(r.accountId)?.platform,
            totals: emptyTotals(),
          };
          campaigns.set(key, c);
        }
        c.campaignName = r.campaignName; // si la renombraron, queda el nombre mas reciente (las filas vienen por fecha)
        add(c.totals, r);
        const acc = perAccount.get(r.accountId);
        if (acc) add(acc, r);
      } else if (r.date >= prevSince && r.date <= prevUntil) {
        add(previousTotals, r);
        hasPrevious = true;
      }
    }

    return {
      currency,
      totals,
      previous: hasPrevious ? previousTotals : null,
      daily: [...dailyMap].map(([date, spend]) => ({ date, spend })),
      campaigns: [...campaigns.values()].sort((a, b) => b.totals.spend - a.totals.spend),
      accounts: [...perAccount]
        .map(([id, t]) => ({ id, name: accountById.get(id)?.name ?? id, platform: accountById.get(id)?.platform, totals: t }))
        .sort((a, b) => b.totals.spend - a.totals.spend),
      platforms: [...perPlatform].map(([platform, t]) => ({ platform, totals: t })).sort((a, b) => b.totals.spend - a.totals.spend),
    };
  });
}
