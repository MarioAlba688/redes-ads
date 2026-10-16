import { afterEach, describe, expect, it, vi } from "vitest";
import { setMetaEnv } from "./helpers/meta-env";

// env() guarda su resultado la primera vez: cada caso recarga los modulos para leer su propio APP_TIMEZONE.
async function load(timezone?: string) {
  vi.resetModules();
  setMetaEnv({ APP_TIMEZONE: timezone });
  return (await import("@/lib/display-time")).dateTimeFormat;
}

afterEach(() => setMetaEnv());

// 02:30 UTC del 16 de octubre = 21:30 del 15 en Bogota.
const instant = new Date("2026-10-16T02:30:00Z");

describe("dateTimeFormat", () => {
  it("usa America/Bogota si no se configura APP_TIMEZONE (y no la zona del servidor)", async () => {
    const fmt = await load();
    expect(fmt().format(instant)).toMatch(/15 oct 2026.*21:30/);
  });

  it("usa la zona de APP_TIMEZONE", async () => {
    const fmt = await load("UTC");
    expect(fmt().format(instant)).toMatch(/16 oct 2026.*\b0?2:30/); // el locale es escribe «2:30» sin cero
  });

  it("una zona explicita (la de una marca) manda sobre la de la app", async () => {
    const fmt = await load("America/Bogota");
    expect(fmt({ timeZone: "Europe/Madrid" }).format(instant)).toMatch(/16 oct 2026.*\b0?4:30/);
  });

  it("sin hora solo muestra el dia", async () => {
    const fmt = await load("America/Bogota");
    const text = fmt({ time: false }).format(instant);
    expect(text).toMatch(/15 oct 2026/);
    expect(text).not.toMatch(/21:30/);
  });

  it("una zona horaria inventada se rechaza con un mensaje claro", async () => {
    const fmt = await load("Marte/Base_Uno");
    expect(() => fmt()).toThrow(/APP_TIMEZONE/);
  });
});
