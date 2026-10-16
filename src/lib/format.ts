/** Formatos de numeros para las pantallas (es). */

export function formatMoney(value: number, currency: string, opts: { compact?: boolean } = {}): string {
  try {
    // Sin forzar decimales: cada moneda tiene los suyos (USD 2, COP y JPY 0).
    return new Intl.NumberFormat("es", {
      style: "currency",
      currency,
      ...(opts.compact ? { notation: "compact" as const, maximumFractionDigits: 1 } : {}),
    }).format(value);
  } catch {
    // Codigo de moneda desconocido ("N/D" u otro): mostramos el numero con el codigo al lado.
    return `${value.toLocaleString("es", { maximumFractionDigits: 2 })} ${currency}`;
  }
}

export const formatInt = (value: number) => new Intl.NumberFormat("es").format(Math.round(value));

export const formatCompact = (value: number) =>
  new Intl.NumberFormat("es", { notation: "compact", maximumFractionDigits: 1 }).format(value);

/** 0.0123 -> "1,23 %" */
export const formatPercent = (ratio: number, digits = 2) =>
  `${new Intl.NumberFormat("es", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(ratio * 100)} %`;

/** 0.123 -> "+12,3 %" / "−4,1 %" (con signo, para variaciones). */
export function formatDelta(ratio: number): string {
  const sign = ratio > 0 ? "+" : ratio < 0 ? "−" : "";
  return `${sign}${new Intl.NumberFormat("es", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(ratio) * 100)} %`;
}
