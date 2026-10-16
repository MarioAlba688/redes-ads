// Dinero en la Marketing API de Meta. Logica pura: la usan la validacion, el servicio y las pruebas.
//
// Meta no recibe el presupuesto en pesos o dolares sino en la unidad minima de la moneda, y cuantas unidades minimas
// tiene una moneda NO sale de los decimales «normales» que conoce Intl: Meta usa un "offset" propio por moneda.
// El caso que importa aqui: el peso colombiano (COP) tiene offset 1 (50000 pesos = 50000) y el dolar 100 (10 dolares
// = 1000). Si se usaran los dos decimales que Intl asigna al COP, un anuncio de 50.000 pesos saldria como
// 5.000.000. Por eso la tabla es exacta y una moneda que no esta en ella se rechaza: ante la duda no se gasta.

/** Fuente: developers.facebook.com/docs/marketing-api/currencies (consultada el 2026-10-16). */
const OFFSETS: Readonly<Record<string, 1 | 100>> = {
  DZD: 100, ARS: 100, AUD: 100, BHD: 100, BDT: 100, BOB: 100, BGN: 100, BRL: 100, GBP: 100, CAD: 100, CLP: 1, CNY: 100,
  COP: 1, CRC: 1, HRK: 100, CZK: 100, DKK: 100, EGP: 100, EUR: 100, GTQ: 100, HNL: 100, HKD: 100, HUF: 1, ISK: 1,
  INR: 100, IDR: 1, ILS: 100, JPY: 1, JOD: 100, KES: 100, KRW: 1, LVL: 100, LTL: 100, MOP: 100, MYR: 100, MXN: 100,
  NZD: 100, NIO: 100, NGN: 100, NOK: 100, PKR: 100, PYG: 1, PEN: 100, PHP: 100, PLN: 100, QAR: 100, RON: 100, RUB: 100,
  SAR: 100, RSD: 100, SGD: 100, SKK: 100, ZAR: 100, SEK: 100, CHF: 100, TWD: 1, THB: 100, TRY: 100, AED: 100, UAH: 100,
  USD: 100, UYU: 100, VEF: 100, VND: 1, FBZ: 100, VES: 100,
};

/** Unidades minimas por unidad de la moneda segun Meta (COP: 1, USD: 100), o null si la moneda no esta en su tabla. */
export function currencyOffset(currency: string | null | undefined): number | null {
  if (!currency) return null;
  return OFFSETS[currency.trim().toUpperCase()] ?? null;
}

/**
 * Presupuesto en unidades normales -> el entero que espera Meta. null si la moneda no se conoce, el monto no es un
 * numero positivo, o trae mas decimales de los que admite la moneda (100,5 COP no existe; 10,456 USD tampoco).
 */
export function toMinorUnits(amount: number, currency: string | null | undefined): number | null {
  const offset = currencyOffset(currency);
  if (offset === null || typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  const scaled = amount * offset;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6 || rounded <= 0 || !Number.isSafeInteger(rounded)) return null;
  return rounded;
}

/** Lo que devuelve Meta (entero, a veces como texto) -> unidades normales. null si no se puede interpretar. */
export function fromMinorUnits(minor: number | string | null | undefined, currency: string | null | undefined): number | null {
  const offset = currencyOffset(currency);
  if (offset === null || minor === null || minor === undefined || minor === "") return null;
  const n = typeof minor === "string" ? Number(minor) : minor;
  if (!Number.isFinite(n) || n < 0) return null;
  return n / offset;
}

/**
 * Lo que la persona escribio en un campo de presupuesto -> el monto, o null si no es claro. Es estricto a proposito:
 * «50.000» en una moneda sin decimales son cincuenta mil (separador de miles) pero en dolares seria ambiguo, y
 * adivinar mal un presupuesto cuesta dinero. En monedas con decimales no se aceptan separadores de miles.
 */
export function parseBudgetInput(text: string, currency: string | null | undefined): number | null {
  const decimals = budgetDecimals(currency);
  if (decimals === null) return null;
  const t = text.trim().replace(/\s/g, "");
  if (!t) return null;
  let n: number;
  if (decimals === 0) {
    if (/^\d+$/.test(t)) n = Number(t);
    else if (/^\d{1,3}([.,]\d{3})+$/.test(t)) n = Number(t.replace(/[.,]/g, ""));
    else return null;
  } else {
    if (!/^\d+([.,]\d{1,2})?$/.test(t)) return null;
    n = Number(t.replace(",", "."));
  }
  return toMinorUnits(n, currency) === null ? null : n;
}

/** Decimales que admite el presupuesto en esa moneda (COP: 0, USD: 2), para el campo del formulario. */
export function budgetDecimals(currency: string | null | undefined): number | null {
  const offset = currencyOffset(currency);
  return offset === null ? null : offset === 1 ? 0 : 2;
}
