import { describe, expect, it } from "vitest";
import { addDays, fromDbDate, isIsoDate, toDbDate, todayInTimezone } from "@/lib/meta/dates";
import {
  buildReport,
  cpc,
  cpm,
  ctr,
  listDates,
  percentChange,
  type ReportAccount,
  type ReportRow,
} from "@/lib/meta/report";

describe("fechas", () => {
  const instant = new Date("2026-10-16T03:00:00Z");

  it("la fecha de hoy depende de la zona horaria de la cuenta", () => {
    expect(todayInTimezone("America/Bogota", instant)).toBe("2026-10-15"); // aun es 15 en Colombia
    expect(todayInTimezone("Asia/Tokyo", instant)).toBe("2026-10-16");
    expect(todayInTimezone("UTC", instant)).toBe("2026-10-16");
  });

  it("si la zona es invalida o falta, usa UTC", () => {
    expect(todayInTimezone("No/Existe", instant)).toBe("2026-10-16");
    expect(todayInTimezone(null, instant)).toBe("2026-10-16");
  });

  it("suma y resta dias cruzando meses y años", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("convierte entre texto y Date de la base sin desfase de zona horaria", () => {
    const d = toDbDate("2026-10-15");
    expect(d.toISOString()).toBe("2026-10-15T00:00:00.000Z");
    expect(fromDbDate(d)).toBe("2026-10-15");
  });

  it("valida el formato AAAA-MM-DD", () => {
    expect(isIsoDate("2026-10-15")).toBe(true);
    expect(isIsoDate("15/10/2026")).toBe(false);
    expect(isIsoDate("2026-13-45")).toBe(false);
  });

  it("lista los dias de un rango, ambos incluidos", () => {
    expect(listDates("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });
});

describe("indicadores", () => {
  const t = { spend: 50, impressions: 10_000, clicks: 200 };

  it("calcula CTR, CPC y CPM", () => {
    expect(ctr(t)).toBeCloseTo(0.02);
    expect(cpc(t)).toBeCloseTo(0.25);
    expect(cpm(t)).toBeCloseTo(5);
  });

  it("devuelve null en lugar de dividir por cero", () => {
    const z = { spend: 10, impressions: 0, clicks: 0 };
    expect(ctr(z)).toBeNull();
    expect(cpc(z)).toBeNull();
    expect(cpm(z)).toBeNull();
  });

  it("calcula el cambio porcentual", () => {
    expect(percentChange(150, 100)).toBeCloseTo(0.5);
    expect(percentChange(50, 100)).toBeCloseTo(-0.5);
    expect(percentChange(10, 0)).toBeNull();
    expect(percentChange(null, 5)).toBeNull();
  });
});

describe("buildReport", () => {
  const accounts: ReportAccount[] = [
    { id: "a1", name: "Tienda COP", currency: "COP" },
    { id: "a2", name: "Tienda COP 2", currency: "COP" },
    { id: "a3", name: "Tienda USD", currency: "USD" },
  ];
  const row = (p: Partial<ReportRow> & Pick<ReportRow, "accountId" | "date">): ReportRow => ({
    campaignId: "c1",
    campaignName: "Campaña 1",
    spend: 10,
    impressions: 1000,
    clicks: 10,
    ...p,
  });

  // Periodo actual: 2026-10-08..2026-10-14 (7 dias). Anterior: 2026-10-01..2026-10-07.
  const since = "2026-10-08";
  const until = "2026-10-14";

  it("agrupa por moneda y nunca suma monedas distintas", () => {
    const rep = buildReport({
      accounts,
      since,
      until,
      rows: [
        row({ accountId: "a1", date: "2026-10-08", spend: 100 }),
        row({ accountId: "a2", date: "2026-10-09", spend: 50 }),
        row({ accountId: "a3", date: "2026-10-09", spend: 7 }),
      ],
    });
    expect(rep.map((r) => r.currency)).toEqual(["COP", "USD"]);
    expect(rep[0].totals.spend).toBe(150);
    expect(rep[1].totals.spend).toBe(7);
  });

  it("la serie diaria incluye los dias sin gasto como cero", () => {
    const [cop] = buildReport({
      accounts,
      since,
      until,
      rows: [row({ accountId: "a1", date: "2026-10-10", spend: 30 })],
    });
    expect(cop.daily).toHaveLength(7);
    expect(cop.daily.find((d) => d.date === "2026-10-10")?.spend).toBe(30);
    expect(cop.daily.filter((d) => d.spend === 0)).toHaveLength(6);
  });

  it("calcula el periodo anterior de igual duracion y deja null si no hay datos", () => {
    const withPrev = buildReport({
      accounts,
      since,
      until,
      rows: [
        row({ accountId: "a1", date: "2026-10-10", spend: 120 }),
        row({ accountId: "a1", date: "2026-10-03", spend: 100 }), // dentro del periodo anterior
        row({ accountId: "a1", date: "2026-09-20", spend: 999 }), // fuera de ambos periodos
      ],
    })[0];
    expect(withPrev.previous?.spend).toBe(100);
    expect(withPrev.totals.spend).toBe(120);

    const noPrev = buildReport({ accounts, since, until, rows: [row({ accountId: "a1", date: "2026-10-10" })] })[0];
    expect(noPrev.previous).toBeNull();
  });

  it("ordena campañas por gasto y conserva el nombre mas reciente", () => {
    const [cop] = buildReport({
      accounts,
      since,
      until,
      rows: [
        row({ accountId: "a1", date: "2026-10-08", campaignId: "x", campaignName: "Viejo nombre", spend: 5 }),
        row({ accountId: "a1", date: "2026-10-09", campaignId: "x", campaignName: "Nombre nuevo", spend: 5 }),
        row({ accountId: "a1", date: "2026-10-09", campaignId: "y", campaignName: "Grande", spend: 80 }),
      ],
    });
    expect(cop.campaigns.map((c) => c.campaignName)).toEqual(["Grande", "Nombre nuevo"]);
    expect(cop.campaigns[1].totals.spend).toBe(10);
  });

  it("totaliza por cuenta, incluidas las que no tuvieron gasto", () => {
    const [cop] = buildReport({
      accounts,
      since,
      until,
      rows: [row({ accountId: "a1", date: "2026-10-08", spend: 40 })],
    });
    expect(cop.accounts.map((a) => [a.name, a.totals.spend])).toEqual([
      ["Tienda COP", 40],
      ["Tienda COP 2", 0],
    ]);
  });

  it("las cuentas sin moneda conocida van en su propio grupo", () => {
    const rep = buildReport({ accounts: [{ id: "z", name: "Z", currency: null }], since, until, rows: [] });
    expect(rep[0].currency).toBe("N/D");
  });

  describe("varias plataformas", () => {
    const multi: ReportAccount[] = [
      { id: "m1", name: "Meta USD", currency: "USD", platform: "META" },
      { id: "g1", name: "Google USD", currency: "USD", platform: "GOOGLE_ADS" },
      { id: "t1", name: "TikTok USD", currency: "USD", platform: "TIKTOK" },
      { id: "g2", name: "Google EUR", currency: "EUR", platform: "GOOGLE_ADS" },
    ];

    it("suma las plataformas dentro de una misma moneda y las desglosa de mayor a menor gasto", () => {
      const rows = [
        row({ accountId: "m1", date: "2026-10-10", spend: 10 }),
        row({ accountId: "g1", date: "2026-10-10", spend: 30, campaignId: "g-c" }),
        row({ accountId: "t1", date: "2026-10-11", spend: 20, campaignId: "t-c" }),
        row({ accountId: "g1", date: "2026-10-12", spend: 5, campaignId: "g-c" }),
        row({ accountId: "g2", date: "2026-10-12", spend: 99 }),
      ];
      const rep = buildReport({ accounts: multi, since, until, rows });
      const usd = rep.find((r) => r.currency === "USD")!;
      expect(usd.totals.spend).toBe(65);
      expect(usd.platforms.map((p) => [p.platform, p.totals.spend])).toEqual([["GOOGLE_ADS", 35], ["TIKTOK", 20], ["META", 10]]);
      // Otra moneda no se mezcla, ni siquiera de la misma plataforma.
      const eur = rep.find((r) => r.currency === "EUR")!;
      expect(eur.platforms).toEqual([{ platform: "GOOGLE_ADS", totals: { spend: 99, impressions: 1000, clicks: 10 } }]);
    });

    it("cada campaña y cada cuenta recuerdan su plataforma", () => {
      const rep = buildReport({ accounts: multi, since, until, rows: [row({ accountId: "t1", date: "2026-10-09", campaignId: "t-c" })] });
      const usd = rep.find((r) => r.currency === "USD")!;
      expect(usd.campaigns[0]).toMatchObject({ campaignId: "t-c", platform: "TIKTOK" });
      expect(usd.accounts.find((a) => a.id === "g1")?.platform).toBe("GOOGLE_ADS");
    });

    it("sin plataforma conocida todo cuenta como una sola (compatibilidad con cuentas sin ese dato)", () => {
      const rep = buildReport({ accounts, since, until, rows: [row({ accountId: "a1", date: "2026-10-09" })] });
      expect(rep.find((r) => r.currency === "COP")!.platforms).toEqual([{ platform: "N/D", totals: { spend: 10, impressions: 1000, clicks: 10 } }]);
    });

    it("el periodo anterior no entra en el desglose", () => {
      const rows = [row({ accountId: "t1", date: "2026-10-02", spend: 500 }), row({ accountId: "t1", date: "2026-10-09", spend: 7 })];
      const usd = buildReport({ accounts: multi, since, until, rows }).find((r) => r.currency === "USD")!;
      expect(usd.platforms).toEqual([{ platform: "TIKTOK", totals: { spend: 7, impressions: 1000, clicks: 10 } }]);
      expect(usd.previous?.spend).toBe(500);
    });
  });
});
