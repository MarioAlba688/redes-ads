import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaApiError } from "@/lib/meta/errors";
import { classifyStatsError, fetchFacebookPostMetrics, fetchInstagramMediaMetrics } from "@/lib/meta/post-metrics";
import { setMetaEnv, stubFetch } from "./helpers/meta-env";

beforeEach(() => setMetaEnv());
afterEach(() => vi.unstubAllGlobals());

const page = { externalId: "P1", token: "PAGE-TOKEN" };
const ig = { externalId: "IG1", token: "PAGE-TOKEN" };

const err = (code: number, message: string, status = 400, subcode?: number) => ({
  status,
  body: { error: { message, code, ...(subcode ? { error_subcode: subcode } : {}), type: "OAuthException" } },
});
const insights = (values: Record<string, number>) => ({
  body: { data: Object.entries(values).map(([name, value]) => ({ name, period: "lifetime", values: [{ value }] })) },
});
const FB_POST = { body: { id: "P1_555", reactions: { summary: { total_count: 30 } }, comments: { summary: { total_count: 4 } }, shares: { count: 2 } } };

describe("estadisticas de Facebook", () => {
  it("lee reacciones, comentarios y compartidos de la publicacion, y vistas y alcance de sus insights", async () => {
    const calls = stubFetch((url) =>
      url.pathname.endsWith("/insights") ? insights({ post_media_view: 900, post_total_media_view_unique: 640 }) : FB_POST,
    );
    const res = await fetchFacebookPostMetrics(page, "P1_555");

    expect(res.metrics).toEqual({ views: 900, reach: 640, likes: 30, comments: 4, shares: 2, saves: null });
    expect(res.notes).toEqual([]);
    expect(res.transient).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0].url.pathname).toBe("/v26.0/P1_555");
    expect(calls[0].url.searchParams.get("fields")).toContain("reactions.summary(total_count)");
    expect(calls[0].url.searchParams.get("access_token")).toBe("PAGE-TOKEN");
    expect(calls[1].url.pathname).toBe("/v26.0/P1_555/insights");
    // Las metricas nuevas (las "impresiones" ya no existen en la API).
    expect(calls[1].url.searchParams.get("metric")).toBe("post_media_view,post_total_media_view_unique");
  });

  it("Facebook omite `shares` si nadie la compartio: son 0, no un dato que falta", async () => {
    stubFetch((url) =>
      url.pathname.endsWith("/insights")
        ? insights({ post_media_view: 10, post_total_media_view_unique: 8 })
        : { body: { id: "P1_1", reactions: { summary: { total_count: 0 } }, comments: { summary: { total_count: 0 } } } },
    );
    const res = await fetchFacebookPostMetrics(page, "P1_1");
    expect(res.metrics).toMatchObject({ likes: 0, comments: 0, shares: 0 });
  });

  it("sin pedir insights solo hace una llamada y deja vistas y alcance sin dato", async () => {
    const calls = stubFetch(() => FB_POST);
    const res = await fetchFacebookPostMetrics(page, "P1_555", { insights: false });
    expect(calls).toHaveLength(1);
    expect(res.metrics).toMatchObject({ likes: 30, views: null, reach: null });
    expect(res.notes).toEqual([]);
  });

  it("si Meta retira UNA metrica, se queda con la otra y explica cual falto", async () => {
    const calls = stubFetch((url) => {
      if (!url.pathname.endsWith("/insights")) return FB_POST;
      const metric = url.searchParams.get("metric");
      if (metric === "post_media_view") return insights({ post_media_view: 900 });
      return err(100, "(#100) The value must be a valid insights metric");
    });
    const res = await fetchFacebookPostMetrics(page, "P1_555");

    expect(res.metrics).toMatchObject({ views: 900, reach: null, likes: 30 });
    expect(res.notes).toHaveLength(1);
    expect(res.notes[0]).toContain("alcance");
    expect(res.transient).toBe(false);
    // 1 publicacion + 1 pedido junto (rechazado) + 2 de a una.
    expect(calls.map((c) => c.url.searchParams.get("metric"))).toEqual([null, "post_media_view,post_total_media_view_unique", "post_media_view", "post_total_media_view_unique"]);
  });

  it("si Meta retira las dos, conserva las reacciones y dice que faltaron vistas y alcance", async () => {
    stubFetch((url) => (url.pathname.endsWith("/insights") ? err(100, "(#100) The value must be a valid insights metric") : FB_POST));
    const res = await fetchFacebookPostMetrics(page, "P1_555");
    expect(res.metrics).toMatchObject({ likes: 30, comments: 4, views: null, reach: null });
    expect(res.notes[0]).toContain("vistas");
    expect(res.notes[0]).toContain("alcance");
  });

  it("sin el permiso de insights: guarda lo basico y explica que falta read_insights (no es pasajero)", async () => {
    stubFetch((url) => (url.pathname.endsWith("/insights") ? err(10, "(#10) Application does not have permission for this action", 403) : FB_POST));
    const res = await fetchFacebookPostMetrics(page, "P1_555");
    expect(res.metrics).toMatchObject({ likes: 30, views: null });
    expect(res.notes[0]).toContain("read_insights");
    expect(res.transient).toBe(false);
  });

  it("un limite de uso en los insights es pasajero: se reintentara pronto", async () => {
    stubFetch((url) => (url.pathname.endsWith("/insights") ? err(4, "(#4) Application request limit reached") : FB_POST));
    const res = await fetchFacebookPostMetrics(page, "P1_555");
    expect(res.metrics.likes).toBe(30);
    expect(res.transient).toBe(true);
    expect(res.notes[0]).toMatch(/exceso de consultas/);
  });

  it("un token vencido en los insights se relanza (la cuenta debe quedar como vencida)", async () => {
    stubFetch((url) => (url.pathname.endsWith("/insights") ? err(190, "Error validating access token: Session has expired") : FB_POST));
    await expect(fetchFacebookPostMetrics(page, "P1_555")).rejects.toMatchObject({ isAuthError: true });
  });

  it("si falla la lectura basica se lanza el error: no hay nada que guardar", async () => {
    stubFetch(() => err(200, "(#200) Requires pages_read_engagement permission", 403));
    await expect(fetchFacebookPostMetrics(page, "P1_555")).rejects.toBeInstanceOf(MetaApiError);
  });
});

describe("estadisticas de Instagram", () => {
  const media = { body: { id: "IGM-1", like_count: 25, comments_count: 3 } };

  it("lee me gusta y comentarios de la publicacion, y alcance, vistas, guardados y compartidos de sus insights", async () => {
    const calls = stubFetch((url) => (url.pathname.endsWith("/insights") ? insights({ reach: 700, views: 1200, saved: 9, shares: 4 }) : media));
    const res = await fetchInstagramMediaMetrics(ig, "IGM-1");

    expect(res.metrics).toEqual({ views: 1200, reach: 700, likes: 25, comments: 3, shares: 4, saves: 9 });
    expect(res.notes).toEqual([]);
    expect(calls[0].url.searchParams.get("fields")).toBe("like_count,comments_count");
    expect(calls[1].url.searchParams.get("metric")).toBe("reach,views,saved,shares");
  });

  it("si la cuenta oculta los me gusta, Instagram no manda like_count: queda sin dato (no 0)", async () => {
    stubFetch((url) => (url.pathname.endsWith("/insights") ? insights({ reach: 5, views: 6, saved: 0, shares: 0 }) : { body: { id: "IGM-1", comments_count: 1 } }));
    const res = await fetchInstagramMediaMetrics(ig, "IGM-1");
    expect(res.metrics.likes).toBeNull();
    expect(res.metrics.comments).toBe(1);
    expect(res.metrics.saves).toBe(0);
  });

  it("entiende tambien la forma total_value de los insights", async () => {
    stubFetch((url) =>
      url.pathname.endsWith("/insights")
        ? { body: { data: [{ name: "reach", total_value: { value: 77 } }, { name: "views", total_value: { value: "88" } }] } }
        : media,
    );
    const res = await fetchInstagramMediaMetrics(ig, "IGM-1");
    expect(res.metrics).toMatchObject({ reach: 77, views: 88 });
  });

  it("una metrica que no aplica a este tipo de publicacion no tumba las demas", async () => {
    stubFetch((url) => {
      if (!url.pathname.endsWith("/insights")) return media;
      const metric = url.searchParams.get("metric") ?? "";
      if (metric.includes(",") || metric === "saved") return err(100, "(#100) metric[2] must be one of the following values: reach, views, shares");
      return insights({ [metric]: 11 });
    });
    const res = await fetchInstagramMediaMetrics(ig, "IGM-1");
    expect(res.metrics).toMatchObject({ reach: 11, views: 11, shares: 11, saves: null, likes: 25 });
    expect(res.notes).toHaveLength(1);
    expect(res.notes[0]).toContain("guardados");
  });

  it("sin el permiso de insights de Instagram, explica que falta instagram_manage_insights", async () => {
    stubFetch((url) => (url.pathname.endsWith("/insights") ? err(10, "(#10) Application does not have permission for this action", 403) : media));
    const res = await fetchInstagramMediaMetrics(ig, "IGM-1");
    expect(res.metrics).toMatchObject({ likes: 25, comments: 3, reach: null });
    expect(res.notes[0]).toContain("instagram_manage_insights");
  });
});

describe("classifyStatsError", () => {
  const e = (code: number, message = "x", opts: { status?: number; subcode?: number; network?: boolean } = {}) =>
    new MetaApiError({ message, code, status: opts.status ?? 400, subcode: opts.subcode, network: opts.network });

  it("token vencido o revocado", () => {
    expect(classifyStatsError(e(190), "FACEBOOK_PAGE").kind).toBe("expired");
  });

  it("limite de uso, caida de red y fallo de Meta se reintentan pronto (clases distintas para el tiempo de espera)", () => {
    expect(classifyStatsError(e(4), "FACEBOOK_PAGE").kind).toBe("rate");
    expect(classifyStatsError(new MetaApiError({ message: "x", network: true }), "FACEBOOK_PAGE").kind).toBe("network");
    expect(classifyStatsError(e(2, "boom", { status: 500 }), "FACEBOOK_PAGE").kind).toBe("network");
  });

  it("permisos: nombra los permisos de cada tipo de cuenta y lleva el detalle de Meta", () => {
    const fb = classifyStatsError(e(10, "(#10) no permission"), "FACEBOOK_PAGE");
    expect(fb.kind).toBe("permission");
    expect(fb.message).toContain("pages_read_engagement");
    expect(fb.message).toContain("read_insights");
    expect(fb.message).toContain("(#10) no permission");
    const insta = classifyStatsError(e(200, "(#200) denied", { status: 403 }), "INSTAGRAM_PROFILE");
    expect(insta.message).toContain("instagram_basic");
    expect(insta.message).toContain("instagram_manage_insights");
  });

  it("una publicacion que Meta no encuentra se distingue de un permiso", () => {
    const gone = classifyStatsError(e(100, "(#100) Unsupported get request. Object with ID 'P1_9' does not exist", { subcode: 33 }), "FACEBOOK_PAGE");
    expect(gone.kind).toBe("gone");
    expect(gone.message).toMatch(/borraron|permiso/);
  });

  it("cualquier otro rechazo de Meta lleva su texto, y un error propio no filtra detalles", () => {
    expect(classifyStatsError(e(100, "(#100) algo raro"), "FACEBOOK_PAGE").kind).toBe("other");
    const internal = classifyStatsError(new Error("token=SECRETO en la URL"), "FACEBOOK_PAGE");
    expect(internal.kind).toBe("other");
    expect(internal.message).not.toContain("SECRETO");
  });
});
