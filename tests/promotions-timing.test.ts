import { describe, expect, it } from "vitest";
import { AUDIENCE_TIPS, formatSalesDate, upcomingEvents, upcomingPaydays } from "@/lib/promotions/timing";

describe("upcomingPaydays: quincenas de Colombia", () => {
  it("desde mediados de octubre de 2026: el viernes 30 y luego el viernes 13 de noviembre (el 15 cae domingo y se adelanta)", () => {
    expect(upcomingPaydays("2026-10-16", 2).map((p) => p.date)).toEqual(["2026-10-30", "2026-11-13"]);
  });

  it("incluye el día de hoy si hoy es quincena, y deja de incluirlo al día siguiente", () => {
    expect(upcomingPaydays("2026-10-30", 1)[0].date).toBe("2026-10-30");
    expect(upcomingPaydays("2026-10-31", 1)[0].date).toBe("2026-11-13");
  });

  it("un pago que cae en sábado o domingo se adelanta al viernes; en febrero usa el último día", () => {
    // 28 de febrero de 2026 es sábado -> viernes 27.
    expect(upcomingPaydays("2026-02-16", 1)[0].date).toBe("2026-02-27");
    // 15 de agosto de 2026 es sábado -> viernes 14.
    expect(upcomingPaydays("2026-08-01", 1)[0].date).toBe("2026-08-14");
  });

  it("cruza el fin de año sin saltarse meses", () => {
    expect(upcomingPaydays("2026-12-31", 2).map((p) => p.date)).toEqual(["2027-01-15", "2027-01-29"]);
  });
});

describe("upcomingEvents: fechas comerciales fuertes", () => {
  it("desde el 16 de octubre de 2026: Black Friday (27 nov), Cyber Lunes (30 nov) y la prima de diciembre (viernes 18, porque el 20 cae domingo)", () => {
    const e = upcomingEvents("2026-10-16", 3);
    expect(e.map((x) => [x.label, x.date])).toEqual([
      ["Black Friday", "2026-11-27"],
      ["Cyber Lunes", "2026-11-30"],
      ["Prima de diciembre", "2026-12-18"],
    ]);
  });

  it("las fechas que dependen del calendario salen bien: Madre, Padre y Amor y Amistad de 2026", () => {
    const all = upcomingEvents("2026-01-01", 20);
    const date = (label: string) => all.find((x) => x.label === label)?.date;
    expect(date("Día de la Madre")).toBe("2026-05-10"); // segundo domingo de mayo
    expect(date("Día del Padre")).toBe("2026-06-21"); // tercer domingo de junio
    expect(date("Amor y Amistad")).toBe("2026-09-19"); // tercer sábado de septiembre
  });

  it("después de la última del año, pasa a las del año siguiente", () => {
    const e = upcomingEvents("2026-12-19", 1)[0];
    expect(e.date >= "2027-01-01").toBe(true);
    expect(e.label).toBe("Día de la Madre");
  });

  it("cada fecha trae una nota", () => {
    for (const e of upcomingEvents("2026-01-01", 20)) expect(e.note.length).toBeGreaterThan(10);
  });
});

describe("formatSalesDate", () => {
  it("dice el día de la semana y la fecha, sin correrse de día por la zona horaria", () => {
    expect(formatSalesDate("2026-10-30")).toMatch(/viernes.*30 de octubre/);
    expect(formatSalesDate("2026-11-27")).toMatch(/viernes.*27 de noviembre/);
  });
});

describe("AUDIENCE_TIPS", () => {
  it("cubre consumidor final y empresas", () => {
    expect(AUDIENCE_TIPS).toHaveLength(2);
    expect(AUDIENCE_TIPS.some((t) => /consumidor final/.test(t.who))).toBe(true);
    expect(AUDIENCE_TIPS.some((t) => /empresas/.test(t.who))).toBe(true);
  });
});
