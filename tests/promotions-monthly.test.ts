import { describe, expect, it } from "vitest";
import { daysInclusive, daysLeftInMonth, firstOfMonth, lastOfMonth, monthLabel, monthlyCapError, projectMonthly } from "@/lib/promotions/monthly";

describe("fechas del mes", () => {
  it("primer y ultimo dia del mes, incluidos los meses de 28, 29, 30 y 31 dias", () => {
    expect(firstOfMonth("2026-10-16")).toBe("2026-10-01");
    expect(lastOfMonth("2026-10-16")).toBe("2026-10-31");
    expect(lastOfMonth("2026-11-02")).toBe("2026-11-30");
    expect(lastOfMonth("2026-02-10")).toBe("2026-02-28");
    expect(lastOfMonth("2028-02-10")).toBe("2028-02-29");
    expect(lastOfMonth("2026-12-31")).toBe("2026-12-31");
    expect(lastOfMonth("2026-01-01")).toBe("2026-01-31");
  });

  it("dias entre dos fechas, ambas incluidas (0 si el orden es al reves)", () => {
    expect(daysInclusive("2026-10-16", "2026-10-16")).toBe(1);
    expect(daysInclusive("2026-10-16", "2026-10-31")).toBe(16);
    expect(daysInclusive("2026-10-31", "2026-11-02")).toBe(3);
    expect(daysInclusive("2026-10-16", "2026-10-15")).toBe(0);
  });

  it("dias que quedan del mes contando hoy", () => {
    expect(daysLeftInMonth("2026-10-16")).toBe(16);
    expect(daysLeftInMonth("2026-10-31")).toBe(1);
    expect(daysLeftInMonth("2026-10-01")).toBe(31);
  });

  it("el mes en palabras", () => {
    expect(monthLabel("2026-10")).toBe("octubre de 2026");
    expect(monthLabel("2027-01")).toBe("enero de 2027");
  });
});

describe("projectMonthly", () => {
  const today = "2026-10-16"; // quedan 16 dias del mes (contando hoy)

  it("un anuncio que cabe en el mes: gastado + comprometido + este", () => {
    const [m] = projectMonthly({ today, spentThisMonth: 100_000, active: [{ dailyBudget: 10_000, endsOn: "2026-10-20" }], candidate: { dailyBudget: 20_000, days: 7 } });
    // otro activo: 5 dias (16..20) x 10.000 = 50.000; este: 7 dias x 20.000 = 140.000
    expect(m).toEqual({ month: "2026-10", spent: 100_000, committed: 50_000, candidate: 140_000, total: 290_000 });
  });

  it("un anuncio activo sin fecha de fin conocida cuenta hasta fin de mes", () => {
    const [m] = projectMonthly({ today, spentThisMonth: 0, active: [{ dailyBudget: 1_000, endsOn: null }], candidate: { dailyBudget: 0, days: 1 } });
    expect(m.committed).toBe(16_000);
  });

  it("un anuncio activo que ya termino no compromete nada", () => {
    const [m] = projectMonthly({ today, spentThisMonth: 0, active: [{ dailyBudget: 50_000, endsOn: "2026-10-15" }], candidate: { dailyBudget: 1_000, days: 1 } });
    expect(m.committed).toBe(0);
  });

  it("si cruza el fin de mes, proyecta los dos meses; lo gastado solo cuenta en el mes en curso", () => {
    const months = projectMonthly({ today: "2026-10-28", spentThisMonth: 500_000, active: [], candidate: { dailyBudget: 10_000, days: 10 } });
    expect(months.map((m) => m.month)).toEqual(["2026-10", "2026-11"]);
    // octubre: 28, 29, 30, 31 = 4 dias; noviembre: 6 dias
    expect(months[0]).toMatchObject({ spent: 500_000, candidate: 40_000, total: 540_000 });
    expect(months[1]).toMatchObject({ spent: 0, candidate: 60_000, total: 60_000 });
  });

  it("un otro anuncio activo que sigue en el mes siguiente tambien compromete ese mes", () => {
    const months = projectMonthly({ today: "2026-10-28", spentThisMonth: 0, active: [{ dailyBudget: 5_000, endsOn: "2026-11-03" }], candidate: { dailyBudget: 10_000, days: 10 } });
    expect(months[0].committed).toBe(20_000); // 28..31
    expect(months[1].committed).toBe(15_000); // 1..3
  });

  it("un anuncio de un dia el ultimo dia del mes solo toca ese mes", () => {
    expect(projectMonthly({ today: "2026-10-31", spentThisMonth: 0, active: [], candidate: { dailyBudget: 1_000, days: 1 } })).toHaveLength(1);
  });

  it("cruce de año", () => {
    const months = projectMonthly({ today: "2026-12-30", spentThisMonth: 0, active: [], candidate: { dailyBudget: 1_000, days: 5 } });
    expect(months.map((m) => m.month)).toEqual(["2026-12", "2027-01"]);
    expect(months[0].candidate).toBe(2_000);
    expect(months[1].candidate).toBe(3_000);
  });

  it("no acumula errores de coma flotante con montos en dolares", () => {
    const [m] = projectMonthly({ today, spentThisMonth: 10.1, active: [], candidate: { dailyBudget: 0.1, days: 3 } });
    expect(m.total).toBe(10.4);
  });
});

describe("monthlyCapError", () => {
  const today = "2026-10-16";

  it("si cabe, no hay error (y justo en el tope tambien cabe)", () => {
    const months = projectMonthly({ today, spentThisMonth: 0, active: [], candidate: { dailyBudget: 10_000, days: 7 } }); // 70.000
    expect(monthlyCapError(months, 100_000, "COP")).toBeNull();
    expect(monthlyCapError(months, 70_000, "COP")).toBeNull();
    expect(monthlyCapError(months, 69_999, "COP")).not.toBeNull();
  });

  it("explica las tres partes (gastado, comprometido, este anuncio) y el total, en palabras", () => {
    const months = projectMonthly({ today, spentThisMonth: 600_000, active: [{ dailyBudget: 10_000, endsOn: "2026-10-20" }], candidate: { dailyBudget: 20_000, days: 7 } });
    const msg = monthlyCapError(months, 500_000, "COP") ?? "";
    expect(msg).toContain("tope mensual de la cuenta");
    expect(msg).toContain("octubre de 2026");
    expect(msg).toMatch(/ya se gastaron 600\.000 COP/);
    expect(msg).toMatch(/otros anuncios activos pueden gastar hasta 50\.000 COP/);
    expect(msg).toMatch(/este anuncio puede gastar hasta 140\.000 COP/);
    expect(msg).toMatch(/en total hasta 790\.000 COP/);
    expect(msg).toMatch(/Baja el presupuesto/);
  });

  it("no menciona lo que no hay (sin gasto ni otros anuncios)", () => {
    const msg = monthlyCapError(projectMonthly({ today, spentThisMonth: 0, active: [], candidate: { dailyBudget: 50_000, days: 7 } }), 100_000, "COP") ?? "";
    expect(msg).not.toMatch(/ya se gastaron/);
    expect(msg).not.toMatch(/otros anuncios activos/);
  });

  it("si el que revienta es el mes siguiente, lo dice", () => {
    const months = projectMonthly({ today: "2026-10-30", spentThisMonth: 0, active: [], candidate: { dailyBudget: 100_000, days: 30 } });
    // octubre 2 dias = 200.000; noviembre 28 dias = 2.800.000
    expect(monthlyCapError(months, 1_000_000, "COP")).toContain("noviembre de 2026");
  });
});
