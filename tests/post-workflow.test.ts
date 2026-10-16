import { describe, expect, it } from "vitest";
import { ROLES } from "@/lib/permissions";
import { POST_STATUSES, type PostStatusName } from "@/lib/posts";
import { availableActions, canTransition, FINAL_STATUSES, scheduleError, type PostAction } from "@/lib/post-workflow";

const ALL_ACTIONS: PostAction[] = ["submit", "return", "approve", "schedule", "publishNow", "cancel", "retry"];

describe("transiciones por estado", () => {
  it("el flujo normal: borrador -> revision -> aprobada -> programada", () => {
    expect(canTransition("DRAFT", "submit")).toBe(true);
    expect(canTransition("IN_REVIEW", "approve")).toBe(true);
    expect(canTransition("IN_REVIEW", "return")).toBe(true);
    expect(canTransition("APPROVED", "schedule")).toBe(true);
    expect(canTransition("SCHEDULED", "schedule")).toBe(true); // reprogramar
  });

  it("no se puede saltar la revision: un borrador no se programa ni se publica", () => {
    for (const a of ["approve", "schedule", "publishNow", "return", "retry"] as const) {
      expect(canTransition("DRAFT", a), a).toBe(false);
    }
  });

  it("lo ya publicado o cancelado no vuelve a moverse", () => {
    for (const status of ["PUBLISHED", "CANCELLED"] as const) {
      for (const a of ALL_ACTIONS) expect(canTransition(status, a), `${status}/${a}`).toBe(false);
    }
  });

  it("mientras se publica no se toca nada", () => {
    for (const a of ALL_ACTIONS) expect(canTransition("PUBLISHING", a), a).toBe(false);
  });

  it("una publicacion que fallo o salio a medias solo se puede reintentar", () => {
    for (const status of ["FAILED", "PARTIAL"] as const) {
      expect(ALL_ACTIONS.filter((a) => canTransition(status, a))).toEqual(["retry"]);
    }
  });

  it("cada estado tiene al menos una forma de llegar a el o es el inicial", () => {
    expect(POST_STATUSES).toHaveLength(9);
    expect(FINAL_STATUSES).toEqual(["PUBLISHED", "PARTIAL", "FAILED", "CANCELLED"]);
  });
});

describe("acciones por rol", () => {
  const actions = (status: PostStatusName, role: (typeof ROLES)[number]) => availableActions(status, role);

  it("el editor envia a revision pero no aprueba ni publica", () => {
    expect(actions("DRAFT", "EDITOR")).toEqual(["submit"]);
    expect(actions("IN_REVIEW", "EDITOR")).toEqual([]);
    expect(actions("APPROVED", "EDITOR")).toEqual([]);
  });

  it("el aprobador aprueba, devuelve, programa, publica y cancela, pero no crea", () => {
    expect(actions("DRAFT", "APPROVER")).toEqual([]);
    expect(actions("IN_REVIEW", "APPROVER")).toEqual(["return", "approve", "cancel"]);
    expect(actions("APPROVED", "APPROVER")).toEqual(["schedule", "publishNow", "cancel"]);
    expect(actions("FAILED", "APPROVER")).toEqual(["retry"]);
  });

  it("el administrador puede todo lo que el estado permite", () => {
    expect(actions("DRAFT", "ADMIN")).toEqual(["submit"]);
    expect(actions("IN_REVIEW", "ADMIN")).toEqual(["return", "approve", "cancel"]);
  });

  it("solo lectura no puede hacer nada", () => {
    for (const s of POST_STATUSES) expect(actions(s, "VIEWER"), s).toEqual([]);
  });
});

describe("programacion", () => {
  const now = new Date("2026-10-16T12:00:00Z");

  it("acepta una fecha futura razonable", () => {
    expect(scheduleError(new Date("2026-10-17T09:00:00Z"), now)).toBeNull();
    expect(scheduleError(new Date("2026-10-16T12:05:00Z"), now)).toBeNull();
  });

  it("rechaza el pasado y lo que es casi ahora", () => {
    expect(scheduleError(new Date("2026-10-16T11:00:00Z"), now)).toMatch(/dentro de 2 minutos/);
    expect(scheduleError(new Date("2026-10-16T12:01:00Z"), now)).toMatch(/dentro de 2 minutos/);
  });

  it("rechaza más de un año de anticipación", () => {
    expect(scheduleError(new Date("2027-11-01T12:00:00Z"), now)).toMatch(/más de un año/);
  });
});
