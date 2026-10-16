import { describe, expect, it } from "vitest";
import { maxCharsFor, PLATFORM_LIMITS } from "@/lib/ai/limits";
import {
  assembleText,
  findForbidden,
  normalizeForMatch,
  normalizeHashtags,
  parseAvoidList,
  parseBrandHashtags,
} from "@/lib/ai/text";

describe("palabras vetadas", () => {
  it("compara sin acentos ni mayusculas", () => {
    expect(normalizeForMatch("PROMOCIÓN Única")).toBe("promocion unica");
    expect(findForbidden("Hoy hay una Promoción", ["promocion"])).toEqual(["promocion"]);
    expect(findForbidden("Hoy hay una promocion", ["Promoción"])).toEqual(["Promoción"]);
  });

  it("solo marca palabras completas (vetar 'gratis' no marca 'gratitud')", () => {
    expect(findForbidden("Con gratitud", ["gratis"])).toEqual([]);
    expect(findForbidden("Es gratis, ven", ["gratis"])).toEqual(["gratis"]);
    expect(findForbidden("¡gratis!", ["gratis"])).toEqual(["gratis"]);
    expect(findForbidden("100%gratis", ["gratis"])).toEqual(["gratis"]);
  });

  it("encuentra frases de varias palabras y no confunde 'la ñ' con 'n'", () => {
    expect(findForbidden("El mejor precio del mercado", ["mejor precio"])).toEqual(["mejor precio"]);
    expect(findForbidden("Es un año nuevo", ["ano"])).toEqual(["ano"]); // sin acentos, ñ -> n: ñ pierde la tilde
  });

  it("los caracteres especiales de regex en un termino no rompen la busqueda", () => {
    expect(findForbidden("oferta (limitada) hoy", ["(limitada)"])).toEqual(["(limitada)"]);
    expect(findForbidden("texto normal", ["a.*b", "[x"])).toEqual([]);
  });

  it("parsea la lista de terminos por lineas, comas o punto y coma", () => {
    expect(parseAvoidList("gratis\n  descuento ,  barato;gratis\n\n")).toEqual(["gratis", "descuento", "barato"]);
    expect(parseAvoidList(null)).toEqual([]);
    expect(parseAvoidList("   ")).toEqual([]);
  });

  it("sin terminos no marca nada", () => {
    expect(findForbidden("cualquier cosa", [])).toEqual([]);
  });
});

describe("hashtags", () => {
  it("limpia, agrega # y quita repetidos ignorando mayusculas y acentos", () => {
    expect(normalizeHashtags(["#Moda", "moda", "MODA", "Ropa de Mujer", "##Diseño", "  "], 10)).toEqual([
      "#Moda",
      "#RopadeMujer",
      "#Diseño",
    ]);
  });

  it("respeta el maximo", () => {
    expect(normalizeHashtags(["a", "b", "c", "d"], 2)).toEqual(["#a", "#b"]);
  });

  it("descarta los que no tienen letras ni numeros o son larguisimos", () => {
    expect(normalizeHashtags(["#!!!", "x".repeat(61), "ok"], 5)).toEqual(["#ok"]);
  });

  it("lee los hashtags del perfil de marca en texto libre", () => {
    expect(parseBrandHashtags("#smartec, tecnologia  #Bogota;")).toEqual(["#smartec", "#tecnologia", "#Bogota"]);
    expect(parseBrandHashtags("")).toEqual([]);
  });

  it("arma el texto final con los hashtags separados", () => {
    expect(assembleText("  Hola mundo  ", ["#uno", "#dos"])).toBe("Hola mundo\n\n#uno #dos");
    expect(assembleText("Solo texto", [])).toBe("Solo texto");
  });
});

describe("limites por plataforma", () => {
  it("el mas estricto manda segun los destinos", () => {
    expect(maxCharsFor(["FACEBOOK_PAGE"])).toBe(PLATFORM_LIMITS.facebook.maxChars);
    expect(maxCharsFor(["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"])).toBe(2200);
    expect(maxCharsFor(["INSTAGRAM_PROFILE"])).toBe(2200);
    expect(maxCharsFor([])).toBe(PLATFORM_LIMITS.both.maxChars);
  });
});
