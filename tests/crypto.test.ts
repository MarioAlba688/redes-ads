import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateToken, sha256Hex } from "@/lib/crypto";

const originalKey = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
});

describe("cifrado de secretos (AES-256-GCM)", () => {
  it("descifra lo que cifro", () => {
    const token = "EAAG-token-de-meta-con-ñ-y-símbolos_/+=";
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it("el texto cifrado no contiene el original y cambia en cada cifrado", () => {
    const a = encryptSecret("secreto");
    const b = encryptSecret("secreto");
    expect(a).not.toContain("secreto");
    expect(a).not.toBe(b);
  });

  it("detecta manipulacion del texto cifrado", () => {
    const [v, iv, tag, data] = encryptSecret("secreto").split(".");
    const flipped = Buffer.from(data, "base64url");
    flipped[0] ^= 0xff;
    const tampered = [v, iv, tag, flipped.toString("base64url")].join(".");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("no descifra con otra clave", () => {
    const payload = encryptSecret("secreto");
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptSecret(payload)).toThrow();
  });

  it("rechaza formatos desconocidos", () => {
    expect(() => decryptSecret("basura")).toThrow(/formato/i);
    expect(() => decryptSecret("v9.a.b.c")).toThrow(/formato/i);
  });

  it("exige una clave de 32 bytes", () => {
    process.env.ENCRYPTION_KEY = randomBytes(16).toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/ENCRYPTION_KEY/);
  });
});

describe("tokens", () => {
  it("genera tokens unicos y largos", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateToken()));
    expect(tokens.size).toBe(50);
    for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(43);
  });

  it("sha256Hex coincide con el vector de referencia", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
