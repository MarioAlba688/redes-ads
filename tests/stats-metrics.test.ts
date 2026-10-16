import { describe, expect, it } from "vitest";
import {
  clampCount,
  EMPTY_METRICS,
  engagementRate,
  interactions,
  mergeMetrics,
  nextFetchAfter,
  retryAfterFailure,
  sortRows,
  summarize,
  type PostMetrics,
} from "@/lib/stats/metrics";

const m = (over: Partial<PostMetrics> = {}): PostMetrics => ({ ...EMPTY_METRICS, ...over });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date("2026-10-16T12:00:00Z");
const after = (ms: number) => new Date(T0.getTime() + ms);

describe("clampCount", () => {
  it("acepta numeros y numeros escritos como texto (Meta devuelve ambos)", () => {
    expect(clampCount(42)).toBe(42);
    expect(clampCount("1234")).toBe(1234);
    expect(clampCount(0)).toBe(0);
  });

  it("redondea hacia abajo y limita al maximo de la columna INT", () => {
    expect(clampCount(7.9)).toBe(7);
    expect(clampCount(9_999_999_999)).toBe(2_147_483_647);
  });

  it("lo que no es una cifra valida es null, nunca 0", () => {
    for (const bad of [null, undefined, "", "  ", "abc", -1, NaN, Infinity, {}, [], true]) expect(clampCount(bad)).toBeNull();
  });
});

describe("interacciones y tasa", () => {
  it("suma reacciones, comentarios, compartidos y guardados, ignorando lo que no se conoce", () => {
    expect(interactions(m({ likes: 10, comments: 2, shares: 3, saves: 5 }))).toBe(20);
    expect(interactions(m({ likes: 10, comments: 2 }))).toBe(12);
  });

  it("si no se conoce ninguna cifra, no son 0 interacciones: son desconocidas", () => {
    expect(interactions(EMPTY_METRICS)).toBeNull();
    expect(interactions(m({ views: 100, reach: 80 }))).toBeNull();
  });

  it("la tasa es interacciones entre personas alcanzadas", () => {
    expect(engagementRate(m({ likes: 8, comments: 2, reach: 200 }))).toBeCloseTo(0.05);
  });

  it("sin alcance (o con alcance 0) no hay tasa", () => {
    expect(engagementRate(m({ likes: 8 }))).toBeNull();
    expect(engagementRate(m({ likes: 8, reach: 0 }))).toBeNull();
    expect(engagementRate(m({ reach: 100 }))).toBeNull();
  });

  it("0 interacciones con alcance si es una tasa valida: 0 %", () => {
    expect(engagementRate(m({ likes: 0, comments: 0, shares: 0, reach: 100 }))).toBe(0);
  });
});

describe("mergeMetrics", () => {
  it("cada cifra nueva manda sobre la anterior", () => {
    expect(mergeMetrics(m({ likes: 12 }), m({ likes: 10 })).likes).toBe(12);
  });

  it("un 0 nuevo si reemplaza (alguien quito su reaccion)", () => {
    expect(mergeMetrics(m({ likes: 0 }), m({ likes: 10 })).likes).toBe(0);
  });

  it("si Meta no entrega una cifra esta vez, se conserva la anterior", () => {
    const merged = mergeMetrics(m({ likes: 12, views: null }), m({ likes: 10, views: 500, reach: 300 }));
    expect(merged).toMatchObject({ likes: 12, views: 500, reach: 300 });
  });

  it("sin lectura previa devuelve lo nuevo tal cual", () => {
    expect(mergeMetrics(m({ likes: 1 }), null)).toEqual(m({ likes: 1 }));
  });
});

describe("cuando volver a leer", () => {
  it("el primer par de dias, cada 3 horas", () => {
    expect(nextFetchAfter(T0, after(10 * 60_000))).toEqual(after(10 * 60_000 + 3 * HOUR));
    expect(nextFetchAfter(T0, after(DAY))).toEqual(after(DAY + 3 * HOUR));
  });

  it("hasta las dos semanas, cada 12 horas", () => {
    expect(nextFetchAfter(T0, after(2 * DAY))).toEqual(after(2 * DAY + 12 * HOUR));
    expect(nextFetchAfter(T0, after(13 * DAY))).toEqual(after(13 * DAY + 12 * HOUR));
  });

  it("hasta los 90 dias, una vez al dia", () => {
    expect(nextFetchAfter(T0, after(14 * DAY))).toEqual(after(15 * DAY));
    expect(nextFetchAfter(T0, after(89 * DAY))).toEqual(after(90 * DAY));
  });

  it("pasados los 90 dias ya no se lee sola", () => {
    expect(nextFetchAfter(T0, after(90 * DAY))).toBeNull();
    expect(nextFetchAfter(T0, after(400 * DAY))).toBeNull();
  });

  it("tras un fallo: lo pasajero pronto, el limite de uso despues y lo que pide una persona, de vez en cuando", () => {
    const minutes = (k: Parameters<typeof retryAfterFailure>[0]) => (retryAfterFailure(k, T0).getTime() - T0.getTime()) / 60_000;
    expect(minutes("network")).toBe(30);
    expect(minutes("rate")).toBe(120);
    expect(minutes("permission")).toBe(12 * 60);
    expect(minutes("gone")).toBe(24 * 60);
    expect(minutes("expired")).toBe(60);
    expect(minutes("other")).toBe(12 * 60);
  });
});

describe("summarize", () => {
  const rows = [
    { metrics: m({ views: 1000, reach: 400, likes: 30, comments: 10, shares: 5 }) }, // 45 interacciones
    { metrics: m({ views: 500, reach: 100, likes: 8, comments: 1, shares: 1, saves: 10 }) }, // 20 interacciones
    { metrics: null }, // aun sin leer
  ];

  it("suma lo medido y cuenta aparte lo que falta por leer", () => {
    const s = summarize(rows);
    expect(s).toMatchObject({ measured: 2, pending: 1, views: 1500, reach: 500, likes: 38, comments: 11, shares: 6, saves: 10, interactions: 65 });
  });

  it("el alcance medio es por publicacion (no se puede sumar entre publicaciones)", () => {
    expect(summarize(rows).avgReach).toBe(250);
  });

  it("la tasa pondera por alcance: total de interacciones / total de personas alcanzadas", () => {
    expect(summarize(rows).rate).toBeCloseTo(65 / 500);
  });

  it("una cifra que ninguna publicacion trae queda en null, no en 0", () => {
    const s = summarize([{ metrics: m({ likes: 3, comments: 1 }) }]);
    expect(s.saves).toBeNull();
    expect(s.views).toBeNull();
    expect(s.avgReach).toBeNull();
    expect(s.rate).toBeNull();
  });

  it("la tasa ignora las publicaciones sin alcance (no las cuenta como 0 en ninguna parte)", () => {
    const s = summarize([{ metrics: m({ likes: 100 }) }, { metrics: m({ reach: 100, likes: 5 }) }]);
    expect(s.rate).toBeCloseTo(0.05);
  });

  it("sin publicaciones no inventa nada", () => {
    expect(summarize([])).toMatchObject({ measured: 0, pending: 0, views: null, interactions: null, rate: null });
  });
});

describe("sortRows", () => {
  const row = (id: string, day: number, metrics: PostMetrics | null) => ({ id, publishedAt: new Date(Date.UTC(2026, 9, day)), metrics });
  const a = row("a", 1, m({ likes: 5, reach: 900, views: 10 }));
  const b = row("b", 2, m({ likes: 50, reach: 100, views: 5000 }));
  const c = row("c", 3, null);
  const d = row("d", 4, m({ views: 20 })); // sin interacciones conocidas

  it("por interacciones: de mayor a menor, y lo desconocido al final", () => {
    expect(sortRows([a, b, c, d], "interacciones").map((r) => r.id)).toEqual(["b", "a", "d", "c"]);
  });

  it("por alcance y por vistas", () => {
    expect(sortRows([a, b, c], "alcance").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(sortRows([a, b, c], "vistas").map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("por fecha: lo mas reciente primero, tengan o no cifras", () => {
    expect(sortRows([a, b, c, d], "recientes").map((r) => r.id)).toEqual(["d", "c", "b", "a"]);
  });

  it("los empates se desempatan por fecha y no modifica el arreglo recibido", () => {
    const x = row("x", 5, m({ likes: 7 }));
    const y = row("y", 9, m({ likes: 7 }));
    const input = [x, y];
    expect(sortRows(input, "interacciones").map((r) => r.id)).toEqual(["y", "x"]);
    expect(input.map((r) => r.id)).toEqual(["x", "y"]);
  });
});
