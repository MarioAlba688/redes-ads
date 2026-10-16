import { describe, expect, it } from "vitest";
import { parseStatsFilters, statsHref } from "@/lib/stats/filters";

const BRANDS = ["b1", "b2"];

describe("parseStatsFilters", () => {
  it("sin nada, 30 dias, todas las marcas y todas las redes", () => {
    expect(parseStatsFilters({}, BRANDS)).toEqual({ days: 30, brandId: null, kind: null });
  });

  it("acepta los periodos permitidos", () => {
    for (const d of ["7", "30", "90"]) expect(parseStatsFilters({ dias: d }, BRANDS).days).toBe(Number(d));
  });

  it("un periodo raro vuelve a 30 dias en lugar de fallar", () => {
    for (const d of ["15", "0", "-7", "abc", "", "1e2"]) expect(parseStatsFilters({ dias: d }, BRANDS).days).toBe(30);
  });

  it("la red se pide con su nombre en la direccion", () => {
    expect(parseStatsFilters({ red: "facebook" }, BRANDS).kind).toBe("FACEBOOK_PAGE");
    expect(parseStatsFilters({ red: "instagram" }, BRANDS).kind).toBe("INSTAGRAM_PROFILE");
    expect(parseStatsFilters({ red: "tiktok" }, BRANDS).kind).toBeNull();
    expect(parseStatsFilters({ red: "FACEBOOK_PAGE" }, BRANDS).kind).toBeNull();
  });

  it("una marca que no existe se ignora (no se confia en lo que llega en la direccion)", () => {
    expect(parseStatsFilters({ marca: "b2" }, BRANDS).brandId).toBe("b2");
    expect(parseStatsFilters({ marca: "ajena" }, BRANDS).brandId).toBeNull();
    expect(parseStatsFilters({ marca: "' OR 1=1 --" }, BRANDS).brandId).toBeNull();
  });

  it("si un parametro llega repetido, vale el primero", () => {
    expect(parseStatsFilters({ dias: ["7", "90"], red: ["instagram", "facebook"] }, BRANDS)).toMatchObject({ days: 7, kind: "INSTAGRAM_PROFILE" });
  });
});

describe("statsHref", () => {
  it("siempre lleva el periodo y solo lo demas si se eligio", () => {
    expect(statsHref({ days: 30, brandId: null, kind: null })).toBe("/estadisticas?dias=30");
    expect(statsHref({ days: 7, brandId: "b1", kind: "INSTAGRAM_PROFILE" })).toBe("/estadisticas?dias=7&red=instagram&marca=b1");
  });

  it("el orden por defecto no ensucia la direccion; otro orden si se conserva", () => {
    expect(statsHref({ days: 30, brandId: null, kind: null }, "interacciones")).toBe("/estadisticas?dias=30");
    expect(statsHref({ days: 30, brandId: null, kind: null }, "recientes")).toBe("/estadisticas?dias=30&orden=recientes");
  });

  it("lo que genera se entiende de vuelta", () => {
    const f = { days: 90, brandId: "b2", kind: "FACEBOOK_PAGE" as const };
    const q = new URL(statsHref(f), "http://x").searchParams;
    expect(parseStatsFilters({ dias: q.get("dias"), marca: q.get("marca"), red: q.get("red") }, BRANDS)).toEqual(f);
  });
});
