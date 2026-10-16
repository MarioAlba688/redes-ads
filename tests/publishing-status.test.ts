import { describe, expect, it } from "vitest";
import { derivePostStatus, isTerminal, type TargetStatusName } from "@/lib/publishing/status";

const s = (...statuses: TargetStatusName[]) => statuses.map((status) => ({ status }));

describe("estado de la publicacion segun sus destinos", () => {
  it("todos publicados -> PUBLISHED", () => {
    expect(derivePostStatus(s("PUBLISHED"))).toBe("PUBLISHED");
    expect(derivePostStatus(s("PUBLISHED", "PUBLISHED"))).toBe("PUBLISHED");
  });

  it("ninguno publicado y todos fallidos -> FAILED", () => {
    expect(derivePostStatus(s("FAILED"))).toBe("FAILED");
    expect(derivePostStatus(s("FAILED", "FAILED"))).toBe("FAILED");
  });

  it("mezcla de publicados y fallidos -> PARTIAL", () => {
    expect(derivePostStatus(s("PUBLISHED", "FAILED"))).toBe("PARTIAL");
  });

  it("mientras alguno se esta publicando, la publicacion se esta publicando", () => {
    expect(derivePostStatus(s("PUBLISHING", "PENDING"))).toBe("PUBLISHING");
    expect(derivePostStatus(s("PUBLISHED", "PUBLISHING"))).toBe("PUBLISHING");
  });

  it("si queda alguno pendiente (reintento o su turno), sigue programada", () => {
    expect(derivePostStatus(s("PENDING"))).toBe("SCHEDULED");
    expect(derivePostStatus(s("PUBLISHED", "PENDING"))).toBe("SCHEDULED");
    expect(derivePostStatus(s("FAILED", "PENDING"))).toBe("SCHEDULED");
  });

  it("sin destinos no hay nada que publicar -> FAILED", () => {
    expect(derivePostStatus([])).toBe("FAILED");
  });

  it("solo PUBLISHED, PARTIAL y FAILED son terminales", () => {
    expect(["PUBLISHED", "PARTIAL", "FAILED"].every((x) => isTerminal(x as never))).toBe(true);
    expect(isTerminal("SCHEDULED")).toBe(false);
    expect(isTerminal("PUBLISHING")).toBe(false);
  });
});
