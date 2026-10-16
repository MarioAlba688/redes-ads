import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaApiError } from "@/lib/meta/errors";
import {
  createAd,
  createAdSet,
  createCampaign,
  createCreative,
  listAccountObjects,
  readAdSet,
  readDailyBudget,
  readStatus,
  searchCities,
  searchInterests,
  setDailyBudget,
  setStatus,
  uploadAdImage,
} from "@/lib/meta/marketing";
import { setMetaEnv } from "./helpers/meta-env";

beforeEach(() => setMetaEnv());
afterEach(() => vi.unstubAllGlobals());

const auth = { accountId: "1001", token: "USER-TOKEN" };

type Call = { url: URL; method: string; form: Record<string, string> };
function stub(handler: (c: Call, n: number) => { body: unknown; status?: number }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const form: Record<string, string> = {};
      const b = init?.body;
      if (b instanceof URLSearchParams) for (const [k, v] of b) form[k] = v;
      if (b instanceof FormData) for (const [k, v] of b.entries()) form[k] = v instanceof File ? `[archivo ${v.name} ${v.type} ${v.size}B]` : v;
      const call = { url, method: init?.method ?? "GET", form };
      calls.push(call);
      const r = handler(call, calls.length);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}
const err = (code: number, message: string, status = 400) => ({ status, body: { error: { message, code } } });

describe("crear", () => {
  it("campaña: POST a act_<cuenta>/campaigns, en pausa, con el token en el cuerpo y no en la URL", async () => {
    const calls = stub(() => ({ body: { id: "C1" } }));
    expect(await createCampaign(auth, "Mi campaña", "ENGAGEMENT")).toBe("C1");
    const c = calls[0];
    expect(c.method).toBe("POST");
    expect(c.url.pathname).toBe("/v26.0/act_1001/campaigns");
    expect(c.url.search).toBe("");
    expect(c.form).toMatchObject({ name: "Mi campaña", objective: "OUTCOME_ENGAGEMENT", status: "PAUSED", special_ad_categories: "[]", access_token: "USER-TOKEN" });
  });

  it("conjunto de anuncios: presupuesto en unidades minimas, en pausa, a su campaña", async () => {
    const calls = stub(() => ({ body: { id: "S1" } }));
    await createAdSet(auth, { name: "S", campaignId: "C1", objective: "AWARENESS", dailyBudgetMinor: 50000, endsAt: new Date("2026-10-23T00:00:00Z"), targeting: { geo_locations: { countries: ["CO"] } }, pageId: "P1" });
    expect(calls[0].url.pathname).toBe("/v26.0/act_1001/adsets");
    expect(calls[0].form).toMatchObject({ campaign_id: "C1", daily_budget: "50000", status: "PAUSED", optimization_goal: "REACH" });
  });

  it("anuncio: une el conjunto con el creativo, en pausa", async () => {
    const calls = stub(() => ({ body: { id: "A1" } }));
    expect(await createAd(auth, "A", "S1", "CR1")).toBe("A1");
    expect(calls[0].url.pathname).toBe("/v26.0/act_1001/ads");
    expect(calls[0].form).toMatchObject({ adset_id: "S1", status: "PAUSED", creative: JSON.stringify({ creative_id: "CR1" }) });
  });

  it("si Meta no devuelve el id, es un error (no se sigue con un id vacio)", async () => {
    stub(() => ({ body: {} }));
    await expect(createCampaign(auth, "x", "AWARENESS")).rejects.toBeInstanceOf(MetaApiError);
  });

  it("un error de Meta se propaga con su codigo", async () => {
    stub(() => err(200, "(#200) Requires ads_management permission", 403));
    await expect(createCampaign(auth, "x", "AWARENESS")).rejects.toMatchObject({ isPermissionError: true });
  });
});

describe("creativo", () => {
  it("sin problemas se crea una sola vez", async () => {
    const calls = stub(() => ({ body: { id: "CR1" } }));
    expect(await createCreative(auth, { name: "C", object_story_id: "P1_5" })).toBe("CR1");
    expect(calls).toHaveLength(1);
    expect(calls[0].form).not.toHaveProperty("degrees_of_freedom_spec");
  });

  it("si Meta pide decidir sobre las «mejoras estandar», se repite una vez sin ellas", async () => {
    const calls = stub((_c, n) => (n === 1 ? err(100, "Creative Must Provide enroll_status for Standard Enhancements") : { body: { id: "CR2" } }));
    expect(await createCreative(auth, { name: "C", object_story_id: "P1_5" })).toBe("CR2");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].form.degrees_of_freedom_spec)).toEqual({ creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } } });
    expect(calls[1].form.object_story_id).toBe("P1_5");
  });

  it("cualquier otro error no se reintenta", async () => {
    const calls = stub(() => err(100, "Invalid parameter"));
    await expect(createCreative(auth, { name: "C", object_story_id: "P1_5" })).rejects.toBeInstanceOf(MetaApiError);
    expect(calls).toHaveLength(1);
  });

  it("subir una imagen: multipart a adimages y devuelve el codigo (hash)", async () => {
    const calls = stub(() => ({ body: { images: { "anuncio.jpg": { hash: "abc123", url: "https://x" } } } }));
    const hash = await uploadAdImage(auth, { bytes: new Uint8Array([1, 2, 3]), filename: "anuncio.jpg", mimeType: "image/jpeg" });
    expect(hash).toBe("abc123");
    expect(calls[0].url.pathname).toBe("/v26.0/act_1001/adimages");
    expect(calls[0].form.filename).toContain("[archivo anuncio.jpg image/jpeg 3B]");
  });

  it("si Meta no devuelve el codigo de la imagen, falla", async () => {
    stub(() => ({ body: { images: {} } }));
    await expect(uploadAdImage(auth, { bytes: new Uint8Array([1]), filename: "a.jpg", mimeType: "image/jpeg" })).rejects.toBeInstanceOf(MetaApiError);
  });
});

describe("administrar", () => {
  it("cambiar estado: POST al objeto con el estado", async () => {
    const calls = stub(() => ({ body: { success: true } }));
    await setStatus("USER-TOKEN", "C1", "ACTIVE");
    expect(calls[0].url.pathname).toBe("/v26.0/C1");
    expect(calls[0].form).toMatchObject({ status: "ACTIVE", access_token: "USER-TOKEN" });
  });

  it("cambiar presupuesto y leerlo de vuelta", async () => {
    const calls = stub((c) => (c.method === "POST" ? { body: { success: true } } : { body: { daily_budget: "75000" } }));
    await setDailyBudget("USER-TOKEN", "S1", 75000);
    expect(calls[0].form.daily_budget).toBe("75000");
    expect(await readDailyBudget("USER-TOKEN", "S1")).toBe(75000);
  });

  it("sin presupuesto diario (o en 0) devuelve null", async () => {
    stub(() => ({ body: { id: "S1" } }));
    expect(await readDailyBudget("USER-TOKEN", "S1")).toBeNull();
  });

  it("leer un conjunto: presupuestos como numeros y estado", async () => {
    stub(() => ({ body: { id: "S1", name: "N", status: "PAUSED", effective_status: "CAMPAIGN_PAUSED", campaign_id: "C1", daily_budget: "50000", end_time: "2026-10-23T00:00:00+0000" } }));
    expect(await readAdSet("USER-TOKEN", "S1")).toEqual({
      id: "S1",
      name: "N",
      status: "PAUSED",
      effectiveStatus: "CAMPAIGN_PAUSED",
      campaignId: "C1",
      dailyBudgetMinor: 50000,
      lifetimeBudgetMinor: null,
      endTime: "2026-10-23T00:00:00+0000",
    });
  });

  it("leer el estado de cualquier objeto", async () => {
    stub(() => ({ body: { status: "PAUSED", effective_status: "PENDING_REVIEW" } }));
    expect(await readStatus("USER-TOKEN", "A1")).toEqual({ status: "PAUSED", effectiveStatus: "PENDING_REVIEW" });
  });

  it("listar lo de la cuenta: campañas, conjuntos y anuncios", async () => {
    stub((c) => {
      if (c.url.pathname.endsWith("/campaigns")) return { body: { data: [{ id: "C1", name: "Camp", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_TRAFFIC", daily_budget: "30000" }] } };
      if (c.url.pathname.endsWith("/adsets")) return { body: { data: [{ id: "S1", campaign_id: "C1", status: "ACTIVE", lifetime_budget: "900000" }] } };
      return { body: { data: [{ id: "A1", adset_id: "S1", campaign_id: "C1", effective_status: "ACTIVE" }] } };
    });
    const o = await listAccountObjects(auth);
    expect(o.campaigns[0]).toMatchObject({ id: "C1", objective: "OUTCOME_TRAFFIC", dailyBudgetMinor: 30000, lifetimeBudgetMinor: null });
    expect(o.adSets[0]).toMatchObject({ id: "S1", campaignId: "C1", dailyBudgetMinor: null, lifetimeBudgetMinor: 900000 });
    expect(o.ads[0]).toMatchObject({ id: "A1", adSetId: "S1" });
    expect(o.truncated).toBe(false);
  });

  it("una cuenta enorme: lee solo las primeras paginas y avisa que corto", async () => {
    const calls = stub(() => ({ body: { data: [{ id: "X" }], paging: { cursors: { after: "next" }, next: "https://graph.facebook.com/otra" } } }));
    const o = await listAccountObjects(auth);
    expect(o.truncated).toBe(true);
    expect(calls.length).toBe(9); // 3 listas x 3 paginas
  });
});

describe("busqueda", () => {
  it("intereses: type=adinterest con lo escrito", async () => {
    const calls = stub(() => ({ body: { data: [{ id: 6003139266461, name: "Belleza", path: ["Intereses", "Belleza"] }, { id: 1 }] } }));
    const r = await searchInterests("USER-TOKEN", "belle");
    expect(r).toEqual([{ id: "6003139266461", name: "Belleza", path: "Intereses › Belleza" }]);
    expect(calls[0].url.pathname).toBe("/v26.0/search");
    expect(calls[0].url.searchParams.get("type")).toBe("adinterest");
    expect(calls[0].url.searchParams.get("q")).toBe("belle");
  });

  it("ciudades: type=adgeolocation solo ciudades; la clave es lo que sirve", async () => {
    const calls = stub(() => ({ body: { data: [{ key: "2420605", name: "Bogotá", region: "Bogotá D.C.", country_code: "CO" }, { name: "sin clave" }] } }));
    const r = await searchCities("USER-TOKEN", "bogo");
    expect(r).toEqual([{ key: "2420605", name: "Bogotá", region: "Bogotá D.C.", countryCode: "CO" }]);
    expect(calls[0].url.searchParams.get("type")).toBe("adgeolocation");
    expect(calls[0].url.searchParams.get("location_types")).toBe('["city"]');
  });
});
