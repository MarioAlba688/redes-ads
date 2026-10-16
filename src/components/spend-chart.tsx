"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export type SpendPoint = { date: string; spend: number };

const HEIGHT = 220;
const MARGIN_BASE = { top: 16, right: 12, bottom: 28 };
const MIN_LEFT = 40;
const CHAR_PX = 6.4; // ancho aproximado de un caracter a 11px, para dimensionar el eje Y
const MAX_COLUMNS = 35; // hasta aqui, columnas; con mas dias, linea (las columnas quedarian como rayas)
const MAX_BAR = 24;
const GAP = 2;

/** Eje Y: 4 marcas en numeros redondos (1, 2, 2.5, 5 x 10^n). */
function niceScale(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= rough) ?? 10) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Number(v.toFixed(6)));
  return { top, ticks };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Grafica del gasto diario de una sola serie (sin leyenda: el titulo dice que es).
 * Columnas hasta 35 dias, linea con relleno suave si son mas. El tooltip y la
 * etiqueta del maximo "ayudan" pero no son la unica via: la vista de tabla muestra todo.
 */
export function SpendChart({ data, currency, title }: { data: SpendPoint[]; currency: string; title: string }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();

  const fmtMoney = (v: number, compact = false) => {
    try {
      // Sin forzar decimales: cada moneda tiene los suyos (USD 2, COP y JPY 0).
      return new Intl.NumberFormat("es", {
        style: "currency",
        currency,
        ...(compact ? { notation: "compact" as const, maximumFractionDigits: 1 } : {}),
      }).format(v);
    } catch {
      return `${v.toLocaleString("es", { maximumFractionDigits: 2 })} ${currency}`;
    }
  };
  const fmtDate = (iso: string, long = false) =>
    new Intl.DateTimeFormat("es", long ? { dateStyle: "full", timeZone: "UTC" } : { day: "numeric", month: "short", timeZone: "UTC" }).format(
      new Date(`${iso}T00:00:00Z`),
    );

  const n = data.length;
  const maxSpend = Math.max(...data.map((d) => d.spend), 0);
  const { top, ticks } = niceScale(maxSpend);
  // El margen izquierdo se ajusta al largo de las etiquetas del eje (ej. "200 mil COP"): asi nunca se cortan.
  const longestTick = Math.max(...ticks.map((t) => fmtMoney(t, true).length));
  const MARGIN = { ...MARGIN_BASE, left: Math.max(MIN_LEFT, Math.ceil(longestTick * CHAR_PX) + 14) };
  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const asColumns = n <= MAX_COLUMNS;

  const band = n > 0 ? innerW / n : 0;
  const x = (i: number) => MARGIN.left + band * i + band / 2;
  const y = (v: number) => MARGIN.top + innerH - (v / top) * innerH;
  const barW = Math.min(MAX_BAR, Math.max(band - GAP, 1));
  const peak = data.reduce((best, d, i) => (d.spend > data[best].spend ? i : best), 0);

  const indexFromPointer = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * n)));
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const move = (i: number) => {
      e.preventDefault();
      setActive(Math.min(n - 1, Math.max(0, i)));
    };
    if (e.key === "ArrowRight") move((active ?? -1) + 1);
    else if (e.key === "ArrowLeft") move((active ?? n) - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(n - 1);
    else if (e.key === "Escape") setActive(null);
  };

  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.spend).toFixed(1)}`).join(" ");
  const area = n > 0 ? `${line} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` : "";

  // El tooltip se coloca junto a la marca, sin salirse del contenedor.
  const tip = active !== null ? data[active] : null;
  const tipLeft = active !== null ? Math.min(Math.max(x(active), 90), Math.max(width - 90, 90)) : 0;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          aria-expanded={showTable}
          aria-controls={tableId}
          className="text-xs text-muted hover:text-foreground"
        >
          {showTable ? "Ver gráfica" : "Ver como tabla"}
        </button>
      </div>

      {/* Altura reservada: la grafica se dibuja al cargar el navegador y asi la pagina no "salta". */}
      <div ref={wrapRef} className="relative" style={{ minHeight: HEIGHT }} hidden={showTable}>
        {width > 0 && n > 0 && (
          <>
            <svg
              width={width}
              height={HEIGHT}
              role="img"
              tabIndex={0}
              aria-label={`${title}. ${n} días. Usa las flechas izquierda y derecha para recorrer los días.`}
              onKeyDown={onKey}
              onBlur={() => setActive(null)}
              className="block overflow-visible rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              {/* Ejes: lineas de 1px, continuas y discretas */}
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
                  <text x={MARGIN.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--muted)">
                    {fmtMoney(t, true)}
                  </text>
                </g>
              ))}

              {asColumns ? (
                data.map((d, i) => {
                  const h = Math.max(innerH - (y(d.spend) - MARGIN.top), d.spend > 0 ? 1 : 0);
                  const r = Math.min(4, barW / 2, h);
                  const bx = x(i) - barW / 2;
                  const by = y(0) - h;
                  // 4px redondeado arriba, cuadrado en la base
                  const path = `M${bx},${y(0)} V${by + r} Q${bx},${by} ${bx + r},${by} H${bx + barW - r} Q${bx + barW},${by} ${bx + barW},${by + r} V${y(0)} Z`;
                  return h > 0 ? <path key={d.date} d={path} fill="var(--primary)" opacity={active === null || active === i ? 1 : 0.55} /> : null;
                })
              ) : (
                <>
                  <path d={area} fill="var(--primary)" opacity={0.1} />
                  <path d={line} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {/* Punto final con anillo del color de la superficie */}
                  <circle cx={x(n - 1)} cy={y(data[n - 1].spend)} r={4} fill="var(--primary)" stroke="var(--surface)" strokeWidth={2} />
                </>
              )}

              {/* Etiquetas del eje X: primera, ultima y alguna intermedia, sin amontonarse */}
              {data.map((d, i) => {
                const every = Math.max(1, Math.ceil(n / Math.max(Math.floor(innerW / 64), 1)));
                // La ultima fecha siempre se muestra; las intermedias, solo si dejan al menos un paso de separacion con ella.
                const show = i === 0 || i === n - 1 ? true : i % every === 0 && n - 1 - i >= every;
                return show ? (
                  <text key={d.date} x={x(i)} y={HEIGHT - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize={11} fill="var(--muted)">
                    {fmtDate(d.date)}
                  </text>
                ) : null;
              })}

              {/* Etiqueta solo del maximo (no un numero por cada punto) */}
              {maxSpend > 0 && (
                <text x={Math.min(Math.max(x(peak), MARGIN.left + 24), width - MARGIN.right - 24)} y={y(maxSpend) - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--foreground)">
                  {fmtMoney(maxSpend, true)}
                </text>
              )}

              {/* Guia vertical + marca activa */}
              {active !== null && (
                <>
                  <line x1={x(active)} x2={x(active)} y1={MARGIN.top} y2={y(0)} stroke="var(--muted)" strokeWidth={1} opacity={0.6} />
                  {!asColumns && <circle cx={x(active)} cy={y(data[active].spend)} r={4} fill="var(--primary)" stroke="var(--surface)" strokeWidth={2} />}
                </>
              )}

              {/* Zona de contacto: toda la altura del grafico, mas ancha que cualquier marca */}
              <rect
                x={MARGIN.left}
                y={MARGIN.top}
                width={innerW}
                height={innerH}
                fill="transparent"
                onPointerMove={(e) => setActive(indexFromPointer(e))}
                onPointerLeave={() => setActive(null)}
              />
            </svg>

            {tip && (
              <div
                className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md"
                style={{ left: tipLeft, top: 0 }}
              >
                <p className="text-muted">{fmtDate(tip.date, true)}</p>
                <p className="mt-0.5 flex items-center gap-1.5">
                  <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded bg-primary" />
                  <span className="text-sm font-semibold tabular-nums">{fmtMoney(tip.spend)}</span>
                </p>
              </div>
            )}
            <p className="sr-only" aria-live="polite">
              {tip ? `${fmtDate(tip.date, true)}: ${fmtMoney(tip.spend)}` : ""}
            </p>
          </>
        )}
      </div>

      <div id={tableId} hidden={!showTable}>
        <div className="max-h-72 overflow-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Día</th>
                <th className="px-3 py-2 text-right font-medium">Gasto ({currency})</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.map((d) => (
                <tr key={d.date}>
                  <td className="px-3 py-1.5">{fmtDate(d.date, true)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(d.spend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
