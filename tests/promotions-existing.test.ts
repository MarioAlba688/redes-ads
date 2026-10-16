import { describe, expect, it } from "vitest";
import { MetaApiError } from "@/lib/meta/errors";
import { classifyAdsError } from "@/lib/promotions/errors";
import { activationCapError, budgetHolder, type ExistingObjects } from "@/lib/promotions/existing";
import { statusFromMeta } from "@/lib/promotions/status";
import { effectiveStatusLabel, effectiveStatusTone } from "@/lib/promotions/types";

const COP = { currency: "COP", cap: 50000 };

// Una cuenta con: una campaña con presupuesto en sus conjuntos (2 de 20.000), otra con presupuesto propio (CBO) y otra con presupuesto total.
const objects: ExistingObjects = {
  campaigns: [
    { id: "C1", dailyBudgetMinor: null, lifetimeBudgetMinor: null },
    { id: "C2", dailyBudgetMinor: 30000, lifetimeBudgetMinor: null },
    { id: "C3", dailyBudgetMinor: null, lifetimeBudgetMinor: 500000 },
    { id: "C4", dailyBudgetMinor: null, lifetimeBudgetMinor: null },
  ],
  adSets: [
    { id: "S1", campaignId: "C1", dailyBudgetMinor: 20000, lifetimeBudgetMinor: null },
    { id: "S2", campaignId: "C1", dailyBudgetMinor: 20000, lifetimeBudgetMinor: null },
    { id: "S3", campaignId: "C2", dailyBudgetMinor: null, lifetimeBudgetMinor: null },
    { id: "S4", campaignId: "C3", dailyBudgetMinor: null, lifetimeBudgetMinor: 500000 },
    { id: "S5", campaignId: "C4", dailyBudgetMinor: 40000, lifetimeBudgetMinor: null },
    { id: "S6", campaignId: "C4", dailyBudgetMinor: 40000, lifetimeBudgetMinor: null, status: "ARCHIVED" },
    { id: "S7", campaignId: "C4", dailyBudgetMinor: null, lifetimeBudgetMinor: null },
  ],
  ads: [
    { id: "A1", adSetId: "S1", campaignId: "C1" },
    { id: "A5", adSetId: "S5", campaignId: "C4" },
  ],
};

describe("activationCapError", () => {
  it("una campaña cuyos conjuntos suman menos que el tope se puede activar", () => {
    // C1: 20.000 + 20.000 = 40.000 <= 50.000
    expect(activationCapError(objects, "campaign", "C1", COP)).toBeNull();
  });

  it("en una campaña cuenta la SUMA de sus conjuntos, no cada uno por separado", () => {
    expect(activationCapError(objects, "campaign", "C1", { currency: "COP", cap: 30000 })).toMatch(/supera el tope/);
    expect(activationCapError(objects, "campaign", "C1", { currency: "COP", cap: 30000 })).toMatch(/40000 COP/);
    // pero un solo conjunto (20.000) si cabe en ese mismo tope
    expect(activationCapError(objects, "adset", "S1", { currency: "COP", cap: 30000 })).toBeNull();
  });

  it("con presupuesto de campaña (CBO) manda el de la campaña", () => {
    expect(activationCapError(objects, "campaign", "C2", COP)).toBeNull();
    expect(activationCapError(objects, "campaign", "C2", { currency: "COP", cap: 20000 })).toMatch(/30000 COP/);
    expect(activationCapError(objects, "adset", "S3", { currency: "COP", cap: 20000 })).toMatch(/supera el tope/);
  });

  it("un presupuesto total (no diario) no se puede comprobar contra el tope: no se activa desde aqui", () => {
    expect(activationCapError(objects, "campaign", "C3", COP)).toMatch(/presupuesto total/);
    expect(activationCapError(objects, "adset", "S4", COP)).toMatch(/presupuesto total/);
  });

  it("sin tope fijado no se activa nada", () => {
    expect(activationCapError(objects, "campaign", "C1", { currency: "COP", cap: null })).toMatch(/todavía no tiene un tope/);
  });

  it("un conjunto sin presupuesto comprobable bloquea la activacion de su campaña", () => {
    expect(activationCapError(objects, "campaign", "C4", { currency: "COP", cap: 100000 })).toMatch(/no tiene presupuesto diario/);
  });

  it("los conjuntos archivados no cuentan", () => {
    const only = { ...objects, adSets: objects.adSets.filter((s) => s.campaignId === "C4" && s.id !== "S7") };
    // S5 (40.000) activo y S6 (40.000) archivado: solo cuenta S5.
    expect(activationCapError(only, "campaign", "C4", COP)).toBeNull();
  });

  it("un anuncio cuenta con el presupuesto de su conjunto", () => {
    expect(activationCapError(objects, "ad", "A1", COP)).toBeNull();
    expect(activationCapError(objects, "ad", "A1", { currency: "COP", cap: 10000 })).toMatch(/supera el tope/);
  });

  it("lo que no existe en la cuenta no se activa", () => {
    expect(activationCapError(objects, "campaign", "NOPE", COP)).toMatch(/No se encontró esa campaña/);
    expect(activationCapError(objects, "adset", "NOPE", COP)).toMatch(/No se encontró ese conjunto/);
    expect(activationCapError(objects, "ad", "NOPE", COP)).toMatch(/No se encontró ese anuncio/);
  });

  it("una moneda que Meta no tiene en su tabla impide comprobar (no se asume)", () => {
    expect(activationCapError(objects, "campaign", "C1", { currency: "XYZ", cap: 50000 })).toMatch(/no está en la tabla de Meta/);
  });

  it("la unidad importa: 5000 en USD son 50 dolares, no 5000", () => {
    const usd: ExistingObjects = { campaigns: [{ id: "C", dailyBudgetMinor: 5000, lifetimeBudgetMinor: null }], adSets: [], ads: [] };
    expect(activationCapError(usd, "campaign", "C", { currency: "USD", cap: 50 })).toBeNull();
    expect(activationCapError(usd, "campaign", "C", { currency: "USD", cap: 49.99 })).toMatch(/supera el tope/);
    // En COP (offset 1) esos mismos 5000 serian 5.000 pesos.
    expect(activationCapError(usd, "campaign", "C", { currency: "COP", cap: 5000 })).toBeNull();
  });
});

describe("budgetHolder", () => {
  it("el presupuesto lo tiene la campaña si es suyo, o el conjunto", () => {
    expect(budgetHolder(objects, "campaign", "C2")).toEqual({ level: "campaign", id: "C2", dailyMinor: 30000 });
    expect(budgetHolder(objects, "adset", "S1")).toEqual({ level: "adset", id: "S1", dailyMinor: 20000 });
  });

  it("explica por que no se puede cambiar en cada caso", () => {
    expect(budgetHolder(objects, "ad", "A1")).toHaveProperty("reason", expect.stringMatching(/conjunto de anuncios o en la campaña/));
    expect(budgetHolder(objects, "campaign", "C1")).toHaveProperty("reason", expect.stringMatching(/está en sus conjuntos/));
    expect(budgetHolder(objects, "adset", "S3")).toHaveProperty("reason", expect.stringMatching(/lo tiene su campaña/));
    expect(budgetHolder(objects, "campaign", "C3")).toHaveProperty("reason", expect.stringMatching(/presupuesto total/));
    expect(budgetHolder(objects, "adset", "S4")).toHaveProperty("reason", expect.stringMatching(/presupuesto total/));
    expect(budgetHolder(objects, "adset", "NOPE")).toHaveProperty("reason");
  });
});

describe("statusFromMeta y etiquetas", () => {
  it("activo, en pausa (por si mismo o por su campaña o conjunto) y archivado", () => {
    expect(statusFromMeta("ACTIVE")).toBe("ACTIVE");
    for (const s of ["PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"]) expect(statusFromMeta(s)).toBe("PAUSED");
    for (const s of ["ARCHIVED", "DELETED"]) expect(statusFromMeta(s)).toBe("ARCHIVED");
  });

  it("en revision, con problemas o rechazado no cambia el estado local (solo se muestra)", () => {
    for (const s of ["PENDING_REVIEW", "IN_PROCESS", "WITH_ISSUES", "DISAPPROVED", "PENDING_BILLING_INFO", "PREAPPROVED", "OTRO", null, undefined, ""]) {
      expect(statusFromMeta(s as string)).toBeNull();
    }
  });

  it("etiquetas en español y tono; un estado nuevo de Meta se muestra tal cual", () => {
    expect(effectiveStatusLabel("PENDING_REVIEW")).toBe("En revisión de Meta");
    expect(effectiveStatusLabel("DISAPPROVED")).toBe("Rechazado por Meta");
    expect(effectiveStatusLabel("ALGO_NUEVO")).toBe("ALGO_NUEVO");
    expect(effectiveStatusLabel(null)).toBe("—");
    expect(effectiveStatusTone("ACTIVE")).toBe("success");
    expect(effectiveStatusTone("DISAPPROVED")).toBe("danger");
    expect(effectiveStatusTone("CAMPAIGN_PAUSED")).toBe("warning");
    expect(effectiveStatusTone("PENDING_REVIEW")).toBe("primary");
  });
});

describe("classifyAdsError", () => {
  const e = (message: string, code?: number, status = 400, network = false) => new MetaApiError({ message, code, status, network });

  it("conexion vencida: marca la cuenta como vencida", () => {
    expect(classifyAdsError(e("Session has expired", 190))).toMatchObject({ expired: true, retryable: false });
  });

  it("red, limite de uso y fallos de Meta se pueden reintentar", () => {
    expect(classifyAdsError(e("x", undefined, 0, true))).toMatchObject({ retryable: true, expired: false });
    expect(classifyAdsError(e("(#4) limit", 4))).toMatchObject({ retryable: true });
    expect(classifyAdsError(e("boom", 2, 500))).toMatchObject({ retryable: true });
  });

  it("permisos: nombra ads_management y trae el detalle de Meta", () => {
    const f = classifyAdsError(e("(#200) Requires ads_management permission", 200, 403));
    expect(f.message).toContain("ads_management");
    expect(f.message).toContain("Detalle de Meta: (#200) Requires ads_management permission");
    expect(f.retryable).toBe(false);
  });

  it("metodo de pago, terminos y presupuesto minimo tienen su propio mensaje", () => {
    expect(classifyAdsError(e("The ad account has no valid payment method", 100)).message).toMatch(/método de pago/);
    expect(classifyAdsError(e("You must accept the terms of service", 100)).message).toMatch(/términos/);
    expect(classifyAdsError(e("The daily budget is too low. Minimum budget is 1.00", 100)).message).toMatch(/mínimo/);
  });

  it("cualquier otro rechazo lleva el texto de Meta; un error propio no filtra detalles", () => {
    expect(classifyAdsError(e("(#100) Invalid parameter", 100)).message).toContain("(#100) Invalid parameter");
    const internal = classifyAdsError(new Error("token=SECRETO"));
    expect(internal.message).not.toContain("SECRETO");
    expect(internal.expired).toBe(false);
  });
});
