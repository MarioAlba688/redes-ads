import { describe, expect, it } from "vitest";
import { ROLES, can, isRole, type Permission } from "@/lib/permissions";

const ALL_PERMISSIONS: Permission[] = [
  "team.manage",
  "audit.view",
  "accounts.view",
  "accounts.manage",
  "metrics.view",
  "stats.refresh",
  "brands.view",
  "brands.manage",
  "content.view",
  "content.create",
  "content.approve",
  "content.publish",
  "ai.manage",
];

describe("permisos por rol", () => {
  it("el administrador puede todo", () => {
    for (const p of ALL_PERMISSIONS) expect(can("ADMIN", p)).toBe(true);
  });

  it("solo el administrador gestiona el equipo, el historial y las cuentas conectadas", () => {
    for (const role of ROLES.filter((r) => r !== "ADMIN")) {
      expect(can(role, "team.manage")).toBe(false);
      expect(can(role, "audit.view")).toBe(false);
      expect(can(role, "accounts.manage")).toBe(false);
    }
  });

  it("solo el administrador gestiona las claves y modelos de los motores de IA", () => {
    expect(can("ADMIN", "ai.manage")).toBe(true);
    for (const role of ROLES.filter((r) => r !== "ADMIN")) expect(can(role, "ai.manage")).toBe(false);
  });

  it("el editor crea contenido pero no lo aprueba", () => {
    expect(can("EDITOR", "content.create")).toBe(true);
    expect(can("EDITOR", "content.approve")).toBe(false);
  });

  it("el aprobador aprueba contenido pero no lo crea", () => {
    expect(can("APPROVER", "content.approve")).toBe(true);
    expect(can("APPROVER", "content.create")).toBe(false);
  });

  it("solo lectura puede ver cuentas, metricas, marcas y publicaciones, nada mas", () => {
    for (const p of ["accounts.view", "metrics.view", "brands.view", "content.view"] as const) {
      expect(can("VIEWER", p)).toBe(true);
    }
    for (const p of ["content.create", "content.approve", "content.publish", "brands.manage"] as const) {
      expect(can("VIEWER", p)).toBe(false);
    }
  });

  it("el editor gestiona las marcas; el aprobador no", () => {
    expect(can("EDITOR", "brands.manage")).toBe(true);
    expect(can("APPROVER", "brands.manage")).toBe(false);
  });

  it("publicar, reprogramar y cancelar es de quien aprueba, no del editor", () => {
    expect(can("APPROVER", "content.publish")).toBe(true);
    expect(can("ADMIN", "content.publish")).toBe(true);
    expect(can("EDITOR", "content.publish")).toBe(false);
  });

  it("todos ven las estadisticas, pero solo quien trabaja con contenido las vuelve a leer (cada lectura llama a Meta)", () => {
    for (const role of ROLES) expect(can(role, "metrics.view")).toBe(true);
    for (const role of ["ADMIN", "EDITOR", "APPROVER"] as const) expect(can(role, "stats.refresh")).toBe(true);
    expect(can("VIEWER", "stats.refresh")).toBe(false);
  });

  it("isRole solo acepta roles validos", () => {
    expect(isRole("ADMIN")).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole("SUPERUSER")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});
