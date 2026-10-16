import { describe, expect, it } from "vitest";
import {
  adBody,
  adSetBody,
  campaignBody,
  facebookBoostCreativeBody,
  instagramBoostCreativeBody,
  newAdCreativeBody,
  OBJECTIVE_RULES,
  STANDARD_ENHANCEMENTS_ERROR,
  withStandardEnhancementsOptOut,
} from "@/lib/promotions/mapping";
import { buildMetaTargeting, DEFAULT_TARGETING, describeTargeting, validateTargeting } from "@/lib/promotions/targeting";
import { OBJECTIVES_BY_KIND, type PromotionInput, type Targeting } from "@/lib/promotions/types";
import { isWebUrl, maxTotalSpend, validatePromotion } from "@/lib/promotions/validate";

const targeting = (over: Partial<Targeting> = {}): Targeting => ({ ...DEFAULT_TARGETING, ...over });
const boost = (over: Partial<PromotionInput> = {}): PromotionInput => ({
  kind: "BOOST",
  objective: "ENGAGEMENT",
  name: "Impulso de prueba",
  dailyBudget: 20000,
  durationDays: 7,
  targeting: targeting(),
  creative: { message: "", headline: null, link: null, cta: null, imageKey: null },
  ...over,
});
const newAd = (over: Partial<PromotionInput> = {}): PromotionInput => ({
  kind: "AD",
  objective: "TRAFFIC",
  name: "Anuncio nuevo",
  dailyBudget: 20000,
  durationDays: 7,
  targeting: targeting(),
  creative: { message: "Reserva tu cita", headline: "Reservi", link: "https://reservi.co", cta: "BOOK_NOW", imageKey: "x.jpg" },
  ...over,
});
const CTX = { currency: "COP", cap: 50000, hasImage: true };

describe("segmentacion", () => {
  it("el formato de Meta: pais, edad, intereses en flexible_spec y advantage_audience explicito en 0", () => {
    const spec = buildMetaTargeting(targeting({ ageMin: 25, ageMax: 45, gender: "women", interests: [{ id: "6003139266461", name: "Belleza" }] }));
    expect(spec).toEqual({
      geo_locations: { countries: ["CO"] },
      age_min: 25,
      age_max: 45,
      genders: [2],
      flexible_spec: [{ interests: [{ id: "6003139266461", name: "Belleza" }] }],
      targeting_automation: { advantage_audience: 0 },
    });
  });

  it("todas las personas no manda `genders`; hombres es 1 y mujeres 2", () => {
    expect(buildMetaTargeting(targeting())).not.toHaveProperty("genders");
    expect(buildMetaTargeting(targeting({ gender: "men" }))).toMatchObject({ genders: [1] });
  });

  it("sin intereses no manda flexible_spec (un arreglo vacio lo rechazaria Meta)", () => {
    expect(buildMetaTargeting(targeting())).not.toHaveProperty("flexible_spec");
  });

  it("las ciudades van por su clave, con radio en kilometros, junto a los paises", () => {
    const spec = buildMetaTargeting(targeting({ countries: [], cities: [{ key: "2420605", name: "Bogotá", countryCode: "CO", radiusKm: 30 }] }));
    expect(spec.geo_locations).toEqual({ cities: [{ key: "2420605", radius: 30, distance_unit: "kilometer" }] });
  });

  it("una publicacion de Instagram se limita a la plataforma Instagram; sin ese caso no se manda", () => {
    expect(buildMetaTargeting(targeting(), { instagramOnly: true })).toMatchObject({ publisher_platforms: ["instagram"] });
    expect(buildMetaTargeting(targeting())).not.toHaveProperty("publisher_platforms");
  });

  it("nunca manda el placement «Explorar» de Instagram, que la v26 rechaza", () => {
    expect(JSON.stringify(buildMetaTargeting(targeting(), { instagramOnly: true }))).not.toMatch(/explore/i);
  });

  it("una segmentacion valida no tiene errores", () => {
    expect(validateTargeting(targeting())).toEqual([]);
  });

  it("exige al menos un pais o ciudad, edad coherente y limites de Meta", () => {
    expect(validateTargeting(targeting({ countries: [] })).join(" ")).toMatch(/al menos un país o una ciudad/);
    expect(validateTargeting(targeting({ ageMin: 16 })).join(" ")).toMatch(/entre 18 y 65/);
    expect(validateTargeting(targeting({ ageMax: 70 })).join(" ")).toMatch(/entre 18 y 65/);
    expect(validateTargeting(targeting({ ageMin: 50, ageMax: 30 })).join(" ")).toMatch(/mínima no puede superar/);
    expect(validateTargeting(targeting({ countries: ["XX"] })).join(" ")).toMatch(/no está disponible/);
    expect(validateTargeting(targeting({ countries: ["CO", "CO"] })).join(" ")).toMatch(/repetidos/);
  });

  it("no acepta un pais de la Union Europea (no hay ninguno en la lista) ni una ciudad de alla: Meta pide datos DSA", () => {
    expect(validateTargeting(targeting({ countries: ["ES"] })).join(" ")).toMatch(/no está disponible/);
    const madrid = { key: "2490299", name: "Madrid", countryCode: "ES", radiusKm: 25 };
    expect(validateTargeting(targeting({ countries: [], cities: [madrid] })).join(" ")).toMatch(/Unión Europea.*DSA/);
  });

  it("el radio de una ciudad va de 17 a 80 km y su clave debe ser numerica", () => {
    const base = { key: "2420605", name: "Bogotá", countryCode: "CO", radiusKm: 25 };
    expect(validateTargeting(targeting({ cities: [{ ...base, radiusKm: 10 }] })).join(" ")).toMatch(/entre 17 y 80 km/);
    expect(validateTargeting(targeting({ cities: [{ ...base, radiusKm: 100 }] })).join(" ")).toMatch(/entre 17 y 80 km/);
    expect(validateTargeting(targeting({ cities: [{ ...base, key: "no-numerica" }] })).join(" ")).toMatch(/vuelve a elegirla/);
  });

  it("limita y valida los intereses", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: String(6000 + i), name: `I${i}` }));
    expect(validateTargeting(targeting({ interests: many })).join(" ")).toMatch(/máximo 10 intereses/);
    expect(validateTargeting(targeting({ interests: [{ id: "abc", name: "X" }] })).join(" ")).toMatch(/vuelve a elegirlo/);
    expect(validateTargeting(targeting({ interests: [{ id: "6001", name: "A" }, { id: "6001", name: "A" }] })).join(" ")).toMatch(/repetidos/);
  });

  it("describe a quien llega, en una frase", () => {
    expect(describeTargeting(targeting({ gender: "women", interests: [{ id: "1", name: "Belleza" }] }))).toBe("Colombia · 18–65 años · mujeres, interesadas en Belleza");
  });
});

describe("parametros para Meta", () => {
  it("campaña: siempre en pausa, special_ad_categories declarado y presupuesto no compartido", () => {
    expect(campaignBody("Mi campaña", "ENGAGEMENT")).toEqual({
      name: "Mi campaña",
      objective: "OUTCOME_ENGAGEMENT",
      status: "PAUSED",
      special_ad_categories: "[]",
      is_adset_budget_sharing_enabled: false,
    });
  });

  it("cada objetivo usa el suyo (esquema ODAX)", () => {
    expect(campaignBody("x", "AWARENESS").objective).toBe("OUTCOME_AWARENESS");
    expect(campaignBody("x", "TRAFFIC").objective).toBe("OUTCOME_TRAFFIC");
  });

  const adSet = (objective: "AWARENESS" | "TRAFFIC" | "ENGAGEMENT") =>
    adSetBody({
      name: "Conjunto",
      campaignId: "C1",
      objective,
      dailyBudgetMinor: 50000,
      endsAt: new Date("2026-10-23T12:00:00Z"),
      targeting: { geo_locations: { countries: ["CO"] } },
      pageId: "P1",
    });

  it("conjunto de anuncios: en pausa, presupuesto diario en unidades minimas y fin como segundos UNIX", () => {
    const body = adSet("ENGAGEMENT");
    expect(body).toMatchObject({
      name: "Conjunto",
      campaign_id: "C1",
      status: "PAUSED",
      daily_budget: 50000,
      billing_event: "IMPRESSIONS",
      optimization_goal: "POST_ENGAGEMENT",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      end_time: Math.floor(Date.parse("2026-10-23T12:00:00Z") / 1000),
    });
    expect(JSON.parse(String(body.targeting))).toEqual({ geo_locations: { countries: ["CO"] } });
  });

  it("interaccion promueve la pagina (ON_POST + page_id); trafico va a la web; alcance no manda destino", () => {
    expect(adSet("ENGAGEMENT")).toMatchObject({ destination_type: "ON_POST", promoted_object: JSON.stringify({ page_id: "P1" }) });
    const traffic = adSet("TRAFFIC");
    expect(traffic).toMatchObject({ optimization_goal: "LINK_CLICKS", destination_type: "WEBSITE" });
    expect(traffic).not.toHaveProperty("promoted_object");
    const awareness = adSet("AWARENESS");
    expect(awareness).toMatchObject({ optimization_goal: "REACH" });
    expect(awareness).not.toHaveProperty("destination_type");
    expect(awareness).not.toHaveProperty("promoted_object");
  });

  it("todos los objetivos tienen regla y facturan por impresiones", () => {
    for (const o of ["AWARENESS", "TRAFFIC", "ENGAGEMENT"] as const) expect(OBJECTIVE_RULES[o].billingEvent).toBe("IMPRESSIONS");
  });

  it("impulsar Facebook: solo el id de la publicacion; impulsar Instagram: pagina, cuenta y publicacion", () => {
    expect(facebookBoostCreativeBody("C", "P1_555")).toEqual({ name: "C", object_story_id: "P1_555" });
    expect(instagramBoostCreativeBody("C", { pageId: "P1", instagramUserId: "IG1", mediaId: "M9" })).toEqual({
      name: "C",
      object_id: "P1",
      instagram_user_id: "IG1",
      source_instagram_media_id: "M9",
    });
  });

  it("anuncio nuevo con enlace: link_data con imagen, texto, titular y boton", () => {
    const body = newAdCreativeBody({ name: "N", pageId: "P1", instagramUserId: "IG1", imageHash: "abc", message: "Hola", headline: "Titular", link: "https://reservi.co", cta: "BOOK_NOW" });
    expect(JSON.parse(String(body.object_story_spec))).toEqual({
      page_id: "P1",
      instagram_user_id: "IG1",
      link_data: {
        image_hash: "abc",
        link: "https://reservi.co",
        message: "Hola",
        name: "Titular",
        call_to_action: { type: "BOOK_NOW", value: { link: "https://reservi.co" } },
      },
    });
  });

  it("sin enlace es una foto con su texto; sin cuenta de Instagram no manda instagram_user_id; sin boton no manda call_to_action", () => {
    const photo = JSON.parse(String(newAdCreativeBody({ name: "N", pageId: "P1", instagramUserId: null, imageHash: "abc", message: "Hola", headline: null, link: null, cta: null }).object_story_spec));
    expect(photo).toEqual({ page_id: "P1", photo_data: { image_hash: "abc", caption: "Hola" } });
    const noButton = JSON.parse(String(newAdCreativeBody({ name: "N", pageId: "P1", instagramUserId: null, imageHash: "abc", message: "Hola", headline: null, link: "https://reservi.co", cta: "NO_BUTTON" }).object_story_spec));
    expect(noButton.link_data).not.toHaveProperty("call_to_action");
    expect(noButton.link_data).not.toHaveProperty("name");
  });

  it("con enlace y sin boton elegido usa «Más información»", () => {
    const spec = JSON.parse(String(newAdCreativeBody({ name: "N", pageId: "P1", instagramUserId: null, imageHash: "h", message: "m", headline: null, link: "https://x.co", cta: null }).object_story_spec));
    expect(spec.link_data.call_to_action.type).toBe("LEARN_MORE");
  });

  it("anuncio: une conjunto y creativo, en pausa", () => {
    expect(adBody("A", "S1", "CR1")).toEqual({ name: "A", adset_id: "S1", creative: JSON.stringify({ creative_id: "CR1" }), status: "PAUSED" });
  });

  it("la salida de las «mejoras estandar»: solo si Meta la pide, y sin cambiar lo demas", () => {
    expect(STANDARD_ENHANCEMENTS_ERROR.test("Creative Must Provide enroll_status for Standard Enhancements")).toBe(true);
    expect(STANDARD_ENHANCEMENTS_ERROR.test("Invalid parameter")).toBe(false);
    const body = withStandardEnhancementsOptOut({ name: "C", object_story_id: "P1_5" });
    expect(body).toMatchObject({ name: "C", object_story_id: "P1_5" });
    expect(JSON.parse(String(body.degrees_of_freedom_spec))).toEqual({ creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } } });
  });

  it("todo lo que se crea nace en pausa (nunca gasta antes de que alguien lo active)", () => {
    expect(campaignBody("x", "AWARENESS").status).toBe("PAUSED");
    expect(adSet("AWARENESS").status).toBe("PAUSED");
    expect(adBody("A", "S", "C").status).toBe("PAUSED");
  });
});

describe("validatePromotion", () => {
  it("un impulso correcto no tiene errores", () => {
    expect(validatePromotion(boost(), CTX)).toEqual([]);
  });

  it("un anuncio nuevo correcto tampoco", () => {
    expect(validatePromotion(newAd(), CTX)).toEqual([]);
  });

  it("el presupuesto no puede pasar del tope de la cuenta (el control principal del gasto)", () => {
    const errors = validatePromotion(boost({ dailyBudget: 50001 }), CTX);
    expect(errors.join(" ")).toMatch(/supera el tope/);
    expect(validatePromotion(boost({ dailyBudget: 50000 }), CTX)).toEqual([]);
  });

  it("sin tope fijado no se puede crear nada, y se dice quien lo fija", () => {
    const errors = validatePromotion(boost(), { ...CTX, cap: null });
    expect(errors.join(" ")).toMatch(/todavía no tiene un tope.*administrador/);
  });

  it("presupuesto en 0, negativo, con decimales de mas o de una moneda desconocida: error, no redondeo", () => {
    expect(validatePromotion(boost({ dailyBudget: 0 }), CTX).join(" ")).toMatch(/mayor que 0/);
    expect(validatePromotion(boost({ dailyBudget: -10 }), CTX).join(" ")).toMatch(/mayor que 0/);
    expect(validatePromotion(boost({ dailyBudget: 100.5 }), CTX).join(" ")).toMatch(/sin decimales/);
    expect(validatePromotion(boost({ dailyBudget: 10.456 }), { currency: "USD", cap: 100 }).join(" ")).toMatch(/hasta 2 decimales/);
    expect(validatePromotion(boost(), { currency: "XYZ", cap: 100000 }).join(" ")).toMatch(/no está en la tabla de Meta/);
    expect(validatePromotion(boost(), { currency: null, cap: 100000 }).join(" ")).toMatch(/desconocida/);
  });

  it("la duracion va de 1 a 30 dias, enteros", () => {
    for (const d of [0, 31, 2.5, -1]) expect(validatePromotion(boost({ durationDays: d }), CTX).join(" ")).toMatch(/de 1 a 30 días/);
    for (const d of [1, 30]) expect(validatePromotion(boost({ durationDays: d }), CTX)).toEqual([]);
  });

  it("al impulsar una publicacion no se ofrece «visitas al sitio» (no se le puede agregar un enlace)", () => {
    expect(OBJECTIVES_BY_KIND.BOOST).not.toContain("TRAFFIC");
    expect(validatePromotion(boost({ objective: "TRAFFIC" }), CTX).join(" ")).toMatch(/no está disponible para impulsar/);
  });

  it("un anuncio nuevo de visitas necesita enlace; el enlace debe ser una direccion web", () => {
    expect(validatePromotion(newAd({ creative: { message: "m", headline: null, link: null, cta: null, imageKey: "x.jpg" } }), CTX).join(" ")).toMatch(/hace falta el enlace/);
    expect(validatePromotion(newAd({ creative: { message: "m", headline: null, link: "javascript:alert(1)", cta: null, imageKey: "x.jpg" } }), CTX).join(" ")).toMatch(/no es una dirección web válida/);
    expect(validatePromotion(newAd({ objective: "AWARENESS", creative: { message: "m", headline: null, link: null, cta: null, imageKey: "x.jpg" } }), CTX)).toEqual([]);
  });

  it("un anuncio nuevo necesita texto e imagen", () => {
    expect(validatePromotion(newAd({ creative: { message: "  ", headline: null, link: "https://reservi.co", cta: null, imageKey: "x.jpg" } }), CTX).join(" ")).toMatch(/necesita un texto/);
    expect(validatePromotion(newAd(), { ...CTX, hasImage: false }).join(" ")).toMatch(/necesita una imagen/);
  });

  it("un boton que no es de la lista se rechaza", () => {
    expect(validatePromotion(newAd({ creative: { message: "m", headline: null, link: "https://reservi.co", cta: "HACK" as never, imageKey: "x.jpg" } }), CTX).join(" ")).toMatch(/botón/);
  });

  it("junta todos los errores en una sola respuesta (no de a uno)", () => {
    const errors = validatePromotion(boost({ name: " ", dailyBudget: 0, durationDays: 99, targeting: targeting({ countries: [] }) }), CTX);
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it("un titular o un texto demasiado largos se rechazan", () => {
    expect(validatePromotion(newAd({ creative: { message: "x".repeat(2001), headline: null, link: "https://reservi.co", cta: null, imageKey: "x.jpg" } }), CTX).join(" ")).toMatch(/hasta 2000/);
    expect(validatePromotion(newAd({ creative: { message: "m", headline: "x".repeat(256), link: "https://reservi.co", cta: null, imageKey: "x.jpg" } }), CTX).join(" ")).toMatch(/hasta 255/);
  });
});

describe("isWebUrl y gasto maximo", () => {
  it("acepta http(s) con dominio y rechaza lo demas", () => {
    expect(isWebUrl("https://reservi.co/reservas?x=1")).toBe(true);
    expect(isWebUrl("http://reservi.co")).toBe(true);
    for (const bad of ["reservi.co", "ftp://reservi.co", "javascript:alert(1)", "https://localhost", "", "no es url"]) expect(isWebUrl(bad)).toBe(false);
  });

  it("el gasto maximo es presupuesto diario por los dias, en la unidad de cada moneda", () => {
    expect(maxTotalSpend(20000, 7, "COP")).toBe(140000);
    expect(maxTotalSpend(10.5, 3, "USD")).toBe(31.5);
    expect(maxTotalSpend(10, 0, "USD")).toBeNull();
    expect(maxTotalSpend(10, 3, "XYZ")).toBeNull();
  });
});
