import { describe, expect, it } from "vitest";
import { budgetDecimals, currencyOffset, fromMinorUnits, parseBudgetInput, toMinorUnits } from "@/lib/promotions/currency";

describe("currencyOffset (tabla oficial de Meta)", () => {
  it("el peso colombiano NO tiene subunidad para Meta (offset 1)", () => {
    // La trampa: ISO 4217 le asigna 2 decimales al COP (y muchas librerias lo siguen), pero Meta no: con esos 2
    // decimales se mandarian 100 veces mas pesos de los pedidos. Manda la tabla de Meta, no ninguna otra fuente.
    expect(currencyOffset("COP")).toBe(1);
    expect(toMinorUnits(50000, "COP")).toBe(50000);
    expect(toMinorUnits(50000, "COP")).not.toBe(5000000);
  });

  it("los casos que usa el negocio y los que se confunden con ellos", () => {
    expect(currencyOffset("USD")).toBe(100);
    expect(currencyOffset("EUR")).toBe(100);
    expect(currencyOffset("MXN")).toBe(100);
    expect(currencyOffset("ARS")).toBe(100);
    expect(currencyOffset("PEN")).toBe(100);
    expect(currencyOffset("BRL")).toBe(100);
    expect(currencyOffset("CLP")).toBe(1);
    expect(currencyOffset("JPY")).toBe(1);
    expect(currencyOffset("KRW")).toBe(1);
    expect(currencyOffset("CRC")).toBe(1);
    expect(currencyOffset("PYG")).toBe(1);
  });

  it("no distingue mayusculas ni espacios, y una moneda desconocida es null (no se asume 100)", () => {
    expect(currencyOffset(" cop ")).toBe(1);
    expect(currencyOffset("XYZ")).toBeNull();
    expect(currencyOffset("")).toBeNull();
    expect(currencyOffset(null)).toBeNull();
    expect(currencyOffset(undefined)).toBeNull();
  });
});

describe("toMinorUnits", () => {
  it("COP: 50.000 pesos son 50000 para Meta", () => {
    expect(toMinorUnits(50000, "COP")).toBe(50000);
  });

  it("USD: 10 dolares son 1000 centavos; 10,50 son 1050", () => {
    expect(toMinorUnits(10, "USD")).toBe(1000);
    expect(toMinorUnits(10.5, "USD")).toBe(1050);
  });

  it("no se equivoca por coma flotante (19,99 x 100 no es 1998,9999)", () => {
    expect(toMinorUnits(19.99, "USD")).toBe(1999);
    expect(toMinorUnits(1.15, "EUR")).toBe(115);
    expect(toMinorUnits(0.07, "MXN")).toBe(7);
  });

  it("rechaza decimales que la moneda no admite en lugar de redondear en silencio", () => {
    expect(toMinorUnits(100.5, "COP")).toBeNull();
    expect(toMinorUnits(10.456, "USD")).toBeNull();
    expect(toMinorUnits(1500.5, "JPY")).toBeNull();
  });

  it("rechaza monedas que no estan en la tabla, y montos que no son positivos o no son numeros", () => {
    expect(toMinorUnits(100, "XYZ")).toBeNull();
    expect(toMinorUnits(100, null)).toBeNull();
    for (const bad of [0, -5, NaN, Infinity, -Infinity]) expect(toMinorUnits(bad, "USD")).toBeNull();
    expect(toMinorUnits("10" as unknown as number, "USD")).toBeNull();
  });

  it("un monto tan pequeno que daria 0 unidades se rechaza", () => {
    expect(toMinorUnits(0.001, "USD")).toBeNull();
  });
});

describe("fromMinorUnits", () => {
  it("es la inversa de toMinorUnits", () => {
    expect(fromMinorUnits(50000, "COP")).toBe(50000);
    expect(fromMinorUnits(1050, "USD")).toBe(10.5);
    for (const [amount, cur] of [[12345, "COP"], [10.5, "USD"], [3, "JPY"], [99.99, "EUR"]] as const) {
      expect(fromMinorUnits(toMinorUnits(amount, cur), cur)).toBe(amount);
    }
  });

  it("Meta devuelve los enteros como texto", () => {
    expect(fromMinorUnits("5000", "USD")).toBe(50);
    expect(fromMinorUnits("5000", "COP")).toBe(5000);
  });

  it("lo que no se puede interpretar es null", () => {
    expect(fromMinorUnits(null, "USD")).toBeNull();
    expect(fromMinorUnits(undefined, "USD")).toBeNull();
    expect(fromMinorUnits("", "USD")).toBeNull();
    expect(fromMinorUnits("abc", "USD")).toBeNull();
    expect(fromMinorUnits(-1, "USD")).toBeNull();
    expect(fromMinorUnits(100, "XYZ")).toBeNull();
  });
});

describe("parseBudgetInput (lo que se escribe en el campo)", () => {
  it("COP: 50000 y 50.000 y 50,000 son cincuenta mil", () => {
    expect(parseBudgetInput("50000", "COP")).toBe(50000);
    expect(parseBudgetInput("50.000", "COP")).toBe(50000);
    expect(parseBudgetInput("50,000", "COP")).toBe(50000);
    expect(parseBudgetInput("1.250.000", "COP")).toBe(1250000);
    expect(parseBudgetInput(" 20 000 ", "COP")).toBe(20000);
  });

  it("COP: decimales, ceros y basura se rechazan", () => {
    for (const bad of ["", "  ", "0", "50.5", "50,50", "5.00", "abc", "-100", "1e5", "50.00.000", "$50000"]) {
      expect(parseBudgetInput(bad, "COP"), bad).toBeNull();
    }
  });

  it("USD: acepta punto o coma decimal, hasta dos decimales", () => {
    expect(parseBudgetInput("10", "USD")).toBe(10);
    expect(parseBudgetInput("10.5", "USD")).toBe(10.5);
    expect(parseBudgetInput("10,5", "USD")).toBe(10.5);
    expect(parseBudgetInput("10,25", "USD")).toBe(10.25);
  });

  it("USD: «50.000» es ambiguo (¿50 o cincuenta mil?) y se rechaza en vez de adivinar", () => {
    expect(parseBudgetInput("50.000", "USD")).toBeNull();
    expect(parseBudgetInput("1,500", "USD")).toBeNull();
    expect(parseBudgetInput("10.456", "USD")).toBeNull();
  });

  it("moneda desconocida o monto 0: null", () => {
    expect(parseBudgetInput("100", "XYZ")).toBeNull();
    expect(parseBudgetInput("100", null)).toBeNull();
    expect(parseBudgetInput("0", "USD")).toBeNull();
    expect(parseBudgetInput("0,00", "USD")).toBeNull();
  });
});

describe("budgetDecimals", () => {
  it("COP sin decimales, USD con dos, desconocida null", () => {
    expect(budgetDecimals("COP")).toBe(0);
    expect(budgetDecimals("USD")).toBe(2);
    expect(budgetDecimals("XYZ")).toBeNull();
  });
});
