import { describe, expect, it } from "vitest";
import { formatMoney } from "@/lib/format";
import { MetaApiError } from "@/lib/meta/errors";
import { classifyAdsError } from "@/lib/promotions/errors";
import { failureHints } from "@/lib/promotions/hints";

const ctx = { dailyCap: 4000, currency: "COP" };

describe("classifyAdsError: el mensaje real de Meta en español sobre el presupuesto minimo", () => {
  // Texto literal que devolvio Meta con la cuenta real del usuario (2026-10-16).
  const real = new MetaApiError({ message: "El presupuesto del conjunto de anuncios debe ser de más de $ 3.322. En caso contrario, es posible que los anuncios no se entreguen.", code: 100, status: 400 });

  it("lo reconoce como presupuesto minimo (antes salia como un «Meta rechazó la solicitud» generico) y conserva el numero de Meta", () => {
    const f = classifyAdsError(real);
    expect(f.message).toMatch(/menor que el mínimo/);
    expect(f.message).toContain("más de $ 3.322");
    expect(f.retryable).toBe(false);
  });

  it("y en inglés también", () => {
    expect(classifyAdsError(new MetaApiError({ message: "Your budget is too low. The minimum daily budget is 3322.", code: 100, status: 400 })).message).toMatch(/menor que el mínimo/);
    expect(classifyAdsError(new MetaApiError({ message: "The ad set budget must be more than 3322", code: 100, status: 400 })).message).toMatch(/menor que el mínimo/);
  });

  it("un error de presupuesto que no habla de minimo no se confunde", () => {
    expect(classifyAdsError(new MetaApiError({ message: "Invalid budget type", code: 100, status: 400 })).message).not.toMatch(/menor que el mínimo/);
  });
});

describe("classifyAdsError: la app de Meta en modo de desarrollo (error real, 2026-10-16)", () => {
  const real = new MetaApiError({
    message: "La publicación con contenido publicitario se creó con una app que se encuentra en modo de desarrollo. Debe estar en modo público para crear este anuncio.",
    code: 100,
    subcode: 1885183,
    status: 400,
  });

  it("lo explica en español, dice dónde se cambia y conserva el detalle de Meta", () => {
    const f = classifyAdsError(real);
    expect(f.message).toMatch(/modo de desarrollo/);
    expect(f.message).toMatch(/«Publicar»/);
    expect(f.message).toContain("Detalle de Meta");
    expect(f.expired).toBe(false);
    expect(f.retryable).toBe(false);
  });

  it("se reconoce por el subcódigo aunque Meta lo diga en otro idioma, y por el texto si falta el subcódigo", () => {
    expect(classifyAdsError(new MetaApiError({ message: "Ad creative post was created by an app that is in development mode.", code: 100, subcode: 1885183, status: 400 })).message).toMatch(/modo de desarrollo/);
    expect(classifyAdsError(new MetaApiError({ message: "The app is in development mode", code: 100, status: 400 })).message).toMatch(/modo de desarrollo/);
  });

  it("no confunde otros errores 100 con este", () => {
    expect(classifyAdsError(new MetaApiError({ message: "(#100) Invalid parameter", code: 100, status: 400 })).message).not.toMatch(/modo de desarrollo/);
  });

  it("failureHints manda a publicar la app y a crear de nuevo", () => {
    const h = failureHints(classifyAdsError(real).message, { dailyCap: 4000, currency: "COP" });
    expect(h).toHaveLength(1);
    expect(h[0]).toMatch(/modo Publicado/);
    expect(h[0]).toMatch(/Crear de nuevo/);
  });
});

describe("failureHints", () => {
  it("imagen perdida: manda a restaurarla", () => {
    const h = failureHints("No se encontró el archivo de la imagen en el servidor.", ctx);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatch(/restaura la imagen/);
  });

  it("presupuesto minimo: dice que suba el presupuesto sin pasar del tope diario, con el tope", () => {
    const h = failureHints("Meta rechazó la solicitud. Detalle de Meta: El presupuesto del conjunto de anuncios debe ser de más de $ 3.322.", ctx);
    expect(h[0]).toMatch(/Sube el presupuesto diario/);
    expect(h[0]).toContain(formatMoney(4000, "COP"));
  });

  it("presupuesto minimo sin tope fijado: pide fijarlo", () => {
    const h = failureHints("El presupuesto es menor que el mínimo que Meta permite", { dailyCap: null, currency: "COP" });
    expect(h[0]).toMatch(/fije el tope diario/);
  });

  it("otros fallos corregibles: pago, terminos, conexion, permisos, tope mensual y problemas pasajeros", () => {
    expect(failureHints("La cuenta publicitaria no tiene un método de pago válido.", ctx)[0]).toMatch(/método de pago/);
    expect(failureHints("Hay términos de la cuenta publicitaria sin aceptar.", ctx)[0]).toMatch(/términos/);
    expect(failureHints("La conexión con Meta de esta cuenta venció o fue revocada.", ctx)[0]).toMatch(/Reconecta Meta/);
    expect(failureHints("Meta rechazó la operación por falta de permisos. ads_management", ctx)[0]).toMatch(/ads_management/);
    expect(failureHints("Superaría el tope mensual de la cuenta", ctx)[0]).toMatch(/tope mensual/);
    expect(failureHints("Meta tuvo un problema temporal.", ctx)[0]).toMatch(/pasajero/);
  });

  it("un error que no reconoce no inventa consejos; sin error tampoco", () => {
    expect(failureHints("Meta rechazó la solicitud. Detalle de Meta: algo raro", ctx)).toEqual([]);
    expect(failureHints(null, ctx)).toEqual([]);
    expect(failureHints("", ctx)).toEqual([]);
  });

  it("puede juntar varios consejos si el error trae varias causas", () => {
    const h = failureHints("No se encontró el archivo de la imagen en el servidor. El presupuesto debe ser de más de 3.322.", ctx);
    expect(h).toHaveLength(2);
  });
});
