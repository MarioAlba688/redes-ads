import { describe, expect, it } from "vitest";
import { formatLocalInput, zoneOffsetMinutes, zonedTimeToUtc } from "@/lib/time";

describe("zonas horarias", () => {
  it("el desfase de Bogota es -5 h todo el año (no tiene horario de verano)", () => {
    expect(zoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "America/Bogota")).toBe(-300);
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "America/Bogota")).toBe(-300);
  });

  it("Nueva York cambia con el horario de verano", () => {
    expect(zoneOffsetMinutes(new Date("2026-01-15T12:00:00Z"), "America/New_York")).toBe(-300);
    expect(zoneOffsetMinutes(new Date("2026-07-15T12:00:00Z"), "America/New_York")).toBe(-240);
  });

  it("convierte la hora local de Bogota a UTC", () => {
    expect(zonedTimeToUtc("2026-10-16T09:00", "America/Bogota")?.toISOString()).toBe("2026-10-16T14:00:00.000Z");
    expect(zonedTimeToUtc("2026-10-16T23:30", "America/Bogota")?.toISOString()).toBe("2026-10-17T04:30:00.000Z"); // cruza de dia
  });

  it("respeta el horario de verano de cada zona", () => {
    expect(zonedTimeToUtc("2026-07-01T09:00", "America/New_York")?.toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedTimeToUtc("2026-12-01T09:00", "America/New_York")?.toISOString()).toBe("2026-12-01T14:00:00.000Z");
    expect(zonedTimeToUtc("2026-07-01T09:00", "Europe/Madrid")?.toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(zonedTimeToUtc("2026-01-01T09:00", "Europe/Madrid")?.toISOString()).toBe("2026-01-01T08:00:00.000Z");
  });

  it("una hora que no existe por el salto de verano da null", () => {
    // 8 de marzo de 2026: en Nueva York el reloj salta de 02:00 a 03:00.
    expect(zonedTimeToUtc("2026-03-08T02:30", "America/New_York")).toBeNull();
    expect(zonedTimeToUtc("2026-03-08T03:30", "America/New_York")?.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("una hora que ocurre dos veces (se atrasa el reloj) toma la primera", () => {
    // 1 de noviembre de 2026: en Nueva York 01:30 ocurre en verano (-4) y luego en invierno (-5).
    expect(zonedTimeToUtc("2026-11-01T01:30", "America/New_York")?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("rechaza fechas inexistentes y formatos raros", () => {
    for (const bad of ["2026-02-30T10:00", "2026-13-01T10:00", "2026-10-16T25:00", "2026-10-16 09:00", "2026-10-16", "", "hola"]) {
      expect(zonedTimeToUtc(bad, "America/Bogota"), bad).toBeNull();
    }
  });

  it("una zona horaria desconocida da null en lugar de fallar", () => {
    expect(zonedTimeToUtc("2026-10-16T09:00", "No/Existe")).toBeNull();
  });

  it("formatLocalInput es la operacion inversa", () => {
    const utc = new Date("2026-10-16T14:00:00Z");
    expect(formatLocalInput(utc, "America/Bogota")).toBe("2026-10-16T09:00");
    expect(zonedTimeToUtc(formatLocalInput(utc, "America/Bogota"), "America/Bogota")?.getTime()).toBe(utc.getTime());
    expect(formatLocalInput(new Date("2026-10-16T05:00:00Z"), "Asia/Tokyo")).toBe("2026-10-16T14:00");
    // medianoche se escribe 00:00 (no 24:00)
    expect(formatLocalInput(new Date("2026-10-16T05:00:00Z"), "America/Bogota")).toBe("2026-10-16T00:00");
  });
});
