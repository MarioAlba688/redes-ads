import { describe, expect, it } from "vitest";
import { lengthError, postSchema, textLength } from "@/lib/post-validation";

const base = { brandId: "b1", text: "Hola", linkUrl: "", aiGenerated: "false", aiBrief: "" };

describe("postSchema", () => {
  it("acepta un borrador valido y normaliza los vacios", () => {
    const r = postSchema.parse(base);
    expect(r).toEqual({ brandId: "b1", text: "Hola", linkUrl: null, aiGenerated: false, aiBrief: null });
  });

  it("guarda los saltos de linea como \\n aunque el navegador los mande como \\r\\n", () => {
    const r = postSchema.parse({ ...base, text: "Linea 1\r\n\r\nLinea 2\rLinea 3", aiBrief: "a\r\nb" });
    expect(r.text).toBe("Linea 1\n\nLinea 2\nLinea 3");
    expect(r.aiBrief).toBe("a\nb");
  });

  it("recorta espacios y exige texto", () => {
    expect(postSchema.parse({ ...base, text: "  hola  " }).text).toBe("hola");
    expect(postSchema.safeParse({ ...base, text: "   " }).success).toBe(false);
    expect(postSchema.safeParse({ ...base, text: undefined }).success).toBe(false);
  });

  it("exige marca", () => {
    expect(postSchema.safeParse({ ...base, brandId: "" }).success).toBe(false);
  });

  it("el enlace solo puede ser http o https", () => {
    expect(postSchema.parse({ ...base, linkUrl: " https://reservi.example/planes " }).linkUrl).toBe("https://reservi.example/planes");
    expect(postSchema.parse({ ...base, linkUrl: "http://x.co" }).linkUrl).toBe("http://x.co");
    for (const bad of ["ftp://x.co", "javascript:alert(1)", "reservi.example", "https://con espacio.co", "data:text/html,hola"]) {
      expect(postSchema.safeParse({ ...base, linkUrl: bad }).success, bad).toBe(false);
    }
  });

  it("aiGenerated acepta true/on y todo lo demas es falso", () => {
    expect(postSchema.parse({ ...base, aiGenerated: "true" }).aiGenerated).toBe(true);
    expect(postSchema.parse({ ...base, aiGenerated: "on" }).aiGenerated).toBe(true);
    expect(postSchema.parse({ ...base, aiGenerated: "false" }).aiGenerated).toBe(false);
    expect(postSchema.parse({ ...base, aiGenerated: undefined }).aiGenerated).toBe(false);
  });
});

describe("largo del texto", () => {
  it("cuenta emojis y letras con acento como un caracter", () => {
    expect(textLength("añoñ")).toBe(4);
    expect(textLength("hola 😀")).toBe(6);
    expect(textLength("a\nb")).toBe(3);
  });

  it("el limite lo pone el destino mas estricto", () => {
    expect(lengthError("x".repeat(2200), ["INSTAGRAM_PROFILE"])).toBeNull();
    expect(lengthError("x".repeat(2201), ["INSTAGRAM_PROFILE"])).toMatch(/2201 caracteres y el límite es 2200 \(Instagram\)/);
    expect(lengthError("x".repeat(2201), ["FACEBOOK_PAGE"])).toBeNull();
    expect(lengthError("x".repeat(2201), ["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"])).not.toBeNull();
    expect(lengthError("x".repeat(5001), ["FACEBOOK_PAGE"])).toMatch(/límite es 5000/);
  });
});
