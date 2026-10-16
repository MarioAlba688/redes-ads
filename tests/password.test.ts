import { describe, expect, it } from "vitest";
import { hashPassword, passwordSchema, verifyPassword } from "@/lib/password";

describe("politica de contraseñas", () => {
  it("acepta una contraseña con letras y numeros de 10+ caracteres", () => {
    expect(passwordSchema.safeParse("clave-segura-2026").success).toBe(true);
  });

  it("rechaza las muy cortas", () => {
    expect(passwordSchema.safeParse("abc123").success).toBe(false);
  });

  it("exige al menos una letra y un numero", () => {
    expect(passwordSchema.safeParse("sololetrasaqui").success).toBe(false);
    expect(passwordSchema.safeParse("12345678901234").success).toBe(false);
  });

  it("acepta letras con acento y ñ", () => {
    expect(passwordSchema.safeParse("contraseña-año-1").success).toBe(true);
  });

  it("rechaza mas de 72 bytes (limite de bcrypt)", () => {
    expect(passwordSchema.safeParse("a1".repeat(36)).success).toBe(true); // 72 bytes
    expect(passwordSchema.safeParse("a1".repeat(37)).success).toBe(false); // 74 bytes
    // 40 caracteres pero mas de 72 bytes por ser multibyte
    expect(passwordSchema.safeParse("ñ".repeat(37) + "1abc").success).toBe(false);
  });
});

describe("hash de contraseñas", () => {
  it("verifica la correcta y rechaza la incorrecta", async () => {
    const hash = await hashPassword("clave-segura-2026");
    expect(hash).not.toContain("clave-segura");
    expect(await verifyPassword("clave-segura-2026", hash)).toBe(true);
    expect(await verifyPassword("clave-segura-2027", hash)).toBe(false);
  });

  it("genera hashes distintos para la misma contraseña (sal aleatoria)", async () => {
    const [a, b] = await Promise.all([hashPassword("misma-clave-123"), hashPassword("misma-clave-123")]);
    expect(a).not.toBe(b);
  });
});
