import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEASURABLE_WHERE } from "@/lib/stats/measurable";
import { loadStatRows } from "@/lib/stats/query";
import { refreshDueMetrics, refreshTargetMetrics } from "@/lib/stats/refresh";
import { setMetaEnv, stubFetch } from "./helpers/meta-env";

// La lectura de estadisticas (lib/stats/refresh.ts y query.ts) con la base de datos simulada en memoria y Meta simulado
// con fetch: comprueba que se leen los Reels de Instagram, que los de Facebook y las historias se saltan, que el
// proceso en segundo plano no los busca y que la pantalla Estadisticas los lista.

type Fixture = { accountKind: string; format: string; video: boolean; externalId: string };
type State = {
  fixture: Fixture;
  /** Lo que devolvera `postTarget.findMany` (los destinos a leer, o las filas de la pantalla). */
  rows: unknown[];
  findManyArgs: { where: Record<string, unknown> } | null;
  /** Lo ultimo que se guardo en PostTargetMetrics. */
  saved: Record<string, unknown> | null;
};

const h = vi.hoisted(() => ({ state: {} as State }));

vi.mock("@/lib/crypto", () => ({ decryptSecret: () => "PAGE-TOKEN" }));
vi.mock("@/lib/db", () => {
  const s = h.state;
  return {
    db: {
      postTarget: {
        findUnique: async () => ({
          status: "PUBLISHED",
          externalId: s.fixture.externalId,
          publishedAt: new Date("2026-11-06T10:00:00Z"),
          metrics: null,
          post: { format: s.fixture.format, media: s.fixture.video ? [{ id: "m1" }] : [] },
          account: { id: "a1", name: "Reservi", kind: s.fixture.accountKind, externalId: "ACC1", status: "ACTIVE", accessTokenEnc: "enc", scopes: null },
        }),
        findMany: async (args: { where: Record<string, unknown> }) => {
          s.findManyArgs = args;
          return s.rows;
        },
      },
      postTargetMetrics: {
        updateMany: async () => ({ count: 0 }),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          s.saved = data;
          return data;
        },
      },
      socialAccount: { updateMany: async () => ({ count: 1 }) },
    },
  };
});

const NOW = new Date("2026-11-07T12:00:00Z");
const HOUR = 3_600_000;

const IG_REEL: Fixture = { accountKind: "INSTAGRAM_PROFILE", format: "FEED", video: true, externalId: "IGM-1" };
const FB_REEL: Fixture = { accountKind: "FACEBOOK_PAGE", format: "FEED", video: true, externalId: "FBV-77" };
const FB_PHOTO: Fixture = { accountKind: "FACEBOOK_PAGE", format: "FEED", video: false, externalId: "P1_555" };

beforeEach(() => {
  setMetaEnv();
  Object.assign(h.state, { fixture: IG_REEL, rows: [], findManyArgs: null, saved: null });
});
afterEach(() => vi.unstubAllGlobals());

const insights = (values: Record<string, number>) => ({
  body: { data: Object.entries(values).map(([name, value]) => ({ name, period: "lifetime", values: [{ value }] })) },
});
const igHandler = (url: URL) => (url.pathname.endsWith("/insights") ? insights({ reach: 400, views: 900, saved: 7, shares: 2 }) : { body: { id: "IGM-1", like_count: 12, comments_count: 3 } });
const fbHandler = (url: URL) =>
  url.pathname.endsWith("/insights")
    ? insights({ post_media_view: 900, post_total_media_view_unique: 640 })
    : { body: { id: "P1_555", reactions: { summary: { total_count: 30 } }, comments: { summary: { total_count: 4 } }, shares: { count: 2 } } };
/** Ruta sin la version de la API (v26.0, etc.). */
const route = (calls: { url: URL }[]) => calls.map((c) => c.url.pathname.replace(/^\/v[\d.]+/, ""));

describe("refreshTargetMetrics con videos", () => {
  it("lee un Reel de Instagram como cualquier publicacion: me gusta y comentarios, y sus insights", async () => {
    const calls = stubFetch(igHandler);
    const res = await refreshTargetMetrics("t1", NOW);

    expect(res).toMatchObject({ outcome: "ok" });
    expect(route(calls)).toEqual(["/IGM-1", "/IGM-1/insights"]);
    expect(calls[1].url.searchParams.get("metric")).toBe("reach,views,saved,shares");
    expect(h.state.saved).toMatchObject({ targetId: "t1", views: 900, reach: 400, likes: 12, comments: 3, shares: 2, saves: 7, note: null });
    // Se vuelve a leer con el mismo calendario que una foto: cada 3 horas el primer par de dias.
    expect(h.state.saved?.nextFetchAt).toEqual(new Date(NOW.getTime() + 3 * HOUR));
  });

  it("NO lee un Reel de Facebook: su id es el del video y sus metricas son otras. No llama a Meta ni guarda nada", async () => {
    h.state.fixture = FB_REEL;
    const calls = stubFetch(fbHandler);
    const res = await refreshTargetMetrics("t1", NOW);

    expect(res).toEqual({ outcome: "skipped" });
    expect(calls).toHaveLength(0);
    expect(h.state.saved).toBeNull();
  });

  it("sigue leyendo una foto de Facebook", async () => {
    h.state.fixture = FB_PHOTO;
    const calls = stubFetch(fbHandler);
    const res = await refreshTargetMetrics("t1", NOW);

    expect(res).toMatchObject({ outcome: "ok" });
    expect(route(calls)).toEqual(["/P1_555", "/P1_555/insights"]);
    expect(h.state.saved).toMatchObject({ views: 900, reach: 640, likes: 30, comments: 4, shares: 2 });
  });

  it("una historia no se lee, ni con video ni sin el", async () => {
    for (const video of [true, false]) {
      h.state.fixture = { ...IG_REEL, format: "STORY", video, externalId: "IGM-9" };
      const calls = stubFetch(igHandler);
      expect(await refreshTargetMetrics("t1", NOW)).toEqual({ outcome: "skipped" });
      expect(calls).toHaveLength(0);
    }
    expect(h.state.saved).toBeNull();
  });
});

describe("refreshDueMetrics: lo que busca el proceso en segundo plano", () => {
  it("ya no excluye los videos en la consulta: pide lo medible (todo menos los Reels de Facebook) y lo que toca leer", async () => {
    await refreshDueMetrics(NOW);

    const where = h.state.findManyArgs?.where as Record<string, unknown>;
    // Las historias siguen fuera; los videos ya no se descartan aqui.
    expect(where.post).toEqual({ format: "FEED" });
    expect(JSON.stringify(where.post)).not.toContain("VIDEO");
    // Los dos filtros van juntos en AND: un OR suelto en la raiz se pisaria con el del filtro de medibles.
    expect(where.AND).toEqual([MEASURABLE_WHERE, { OR: [{ metrics: { is: null } }, { metrics: { is: { nextFetchAt: { lte: NOW } } } }] }]);
    expect(where).not.toHaveProperty("OR");
  });

  it("lee el Reel de Instagram que le toca", async () => {
    h.state.rows = [{ id: "t1" }];
    stubFetch(igHandler);

    expect(await refreshDueMetrics(NOW)).toEqual({ refreshed: 1, failed: 0 });
    expect(h.state.saved).toMatchObject({ views: 900, saves: 7 });
  });

  it("aunque la consulta dejara pasar un Reel de Facebook, no se llama a Meta", async () => {
    h.state.fixture = FB_REEL;
    h.state.rows = [{ id: "t1" }];
    const calls = stubFetch(fbHandler);

    expect(await refreshDueMetrics(NOW)).toEqual({ refreshed: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("loadStatRows: lo que lista la pantalla Estadisticas", () => {
  const filters = { days: 30, brandId: null, kind: null };
  const row = (id: string, kind: string, media: { kind: string; storageKey: string; thumbKey: string | null }[]) => ({
    id,
    postId: `p-${id}`,
    externalUrl: null,
    publishedAt: new Date("2026-11-05T10:00:00Z"),
    account: { name: "Reservi", kind },
    post: { text: "Texto", brand: { id: "b1", name: "Marca" }, media },
    metrics: null,
  });

  it("lista los videos: el de Instagram se puede leer, el de Facebook queda marcado, y la miniatura es la portada", async () => {
    h.state.rows = [
      row("t1", "INSTAGRAM_PROFILE", [{ kind: "VIDEO", storageKey: "a.mp4", thumbKey: "a-cover.jpg" }]),
      row("t2", "FACEBOOK_PAGE", [{ kind: "VIDEO", storageKey: "b.mp4", thumbKey: null }]),
      row("t3", "FACEBOOK_PAGE", [{ kind: "IMAGE", storageKey: "c.jpg", thumbKey: null }]),
      row("t4", "INSTAGRAM_PROFILE", []),
    ];
    const rows = await loadStatRows(filters, NOW);

    expect(rows.map((r) => [r.targetId, r.isVideo, r.measurable, r.imageUrl])).toEqual([
      ["t1", true, true, "/media/a-cover.jpg"], // la portada, nunca el MP4 (no es una imagen)
      ["t2", true, false, null], // un video sin portada: la pantalla pone un cuadro de reproducir
      ["t3", false, true, "/media/c.jpg"],
      ["t4", false, true, null],
    ]);
  });

  it("la consulta no excluye los videos ni las lee de mas; con measurableOnly deja solo lo que se puede leer", async () => {
    await loadStatRows(filters, NOW);
    const all = h.state.findManyArgs?.where as Record<string, unknown>;
    expect(all.post).toEqual({ format: "FEED" });
    expect(all).not.toHaveProperty("AND");

    await loadStatRows(filters, NOW, 12, { measurableOnly: true });
    expect(h.state.findManyArgs?.where).toMatchObject({ post: { format: "FEED" }, AND: [MEASURABLE_WHERE] });
  });
});
