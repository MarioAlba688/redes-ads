// Simulador de la Marketing API de Meta (campañas, conjuntos de anuncios, creativos, anuncios, imagenes y busquedas)
// para las pruebas. Lo usa fake-meta.mjs. Imita lo que Meta EXIGE de verdad (esquema de la v26) para que las pruebas
// atrapen errores de mapeo en lugar de aceptar cualquier cosa: ver los `reject` de cada paso.

import { createHash } from "node:crypto";

const OBJECTIVES = {
  OUTCOME_AWARENESS: ["REACH", "IMPRESSIONS"],
  OUTCOME_TRAFFIC: ["LINK_CLICKS", "LANDING_PAGE_VIEWS", "IMPRESSIONS", "REACH"],
  OUTCOME_ENGAGEMENT: ["POST_ENGAGEMENT", "THRUPLAY", "PAGE_LIKES", "IMPRESSIONS", "REACH"],
};
/** Presupuesto diario minimo por moneda, en unidades minimas de la moneda (USD en centavos, COP en pesos). */
const MIN_DAILY = { USD: 100, COP: 2000 };
/** Moneda de cada cuenta publicitaria del simulador (la 1001 es USD, la 1002 COP). */
const CURRENCY = { 1001: "USD", 1002: "COP" };

export const FAKE_INTERESTS = [
  { id: "6003139266461", name: "Belleza", path: ["Intereses", "Belleza"] },
  { id: "6003012345678", name: "Viajes", path: ["Intereses", "Viajes"] },
  { id: "6003020834693", name: "Turismo", path: ["Intereses", "Viajes", "Turismo"] },
  { id: "6003277229371", name: "Cosméticos", path: ["Intereses", "Belleza", "Cosméticos"] },
];
export const FAKE_CITIES = [
  { key: "2420605", name: "Bogotá", region: "Bogotá D.C.", country_code: "CO", type: "city" },
  { key: "2422605", name: "Medellín", region: "Antioquia", country_code: "CO", type: "city" },
  { key: "2490299", name: "Madrid", region: "Comunidad de Madrid", country_code: "ES", type: "city" },
  { key: "2430040", name: "Ciudad de México", region: "Ciudad de México", country_code: "MX", type: "city" },
];

/** Errores que Meta devuelve (codigos reales de la Graph API). */
const FAILURES = {
  perm: (fail) => fail(403, 200, "(#200) Requires ads_management permission to manage the object"),
  auth: (fail) => fail(400, 190, "Error validating access token: The session has been invalidated because the user changed their password.", { error_subcode: 460 }),
  rate: (fail) => fail(400, 17, "(#17) User request limit reached"),
  server: (fail) => fail(500, 2, "An unexpected error has occurred. Please retry your request later."),
  payment: (fail) => fail(400, 100, "(#100) Invalid parameter: The ad account does not have a valid payment method", { error_subcode: 1359188 }),
  invalid: (fail) => fail(400, 100, "(#100) Invalid parameter"),
  // Texto literal de Meta (en español) cuando la app esta en modo «Desarrollo»; subcodigo 1885183.
  devmode: (fail) => fail(400, 100, "La publicación con contenido publicitario se creó con una app que se encuentra en modo de desarrollo. Debe estar en modo público para crear este anuncio.", { error_subcode: 1885183 }),
};

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function createAdsSimulator({ getScenario, graphError, json, userToken }) {
  const fresh = () => ({ seq: 0, campaigns: new Map(), adsets: new Map(), creatives: new Map(), ads: new Map(), images: new Map(), log: [] });
  let db = fresh();

  const newId = () => `12${String(++db.seq).padStart(6, "0")}`;
  const iso = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString().replace(/\.\d{3}Z$/, "+0000") : undefined);

  /** Estado efectivo como lo informa Meta: lo de arriba (campaña, conjunto) manda sobre lo de abajo. */
  const effective = (kind, o) => {
    if (o.status === "DELETED" || o.status === "ARCHIVED") return o.status;
    if (kind === "campaign") return o.status;
    const set = kind === "adset" ? o : db.adsets.get(o.adset_id);
    const camp = db.campaigns.get(set.campaign_id);
    if (camp.status === "DELETED" || camp.status === "ARCHIVED") return camp.status;
    if (camp.status !== "ACTIVE") return "CAMPAIGN_PAUSED";
    if (kind === "adset") return set.status;
    if (set.status !== "ACTIVE") return "ADSET_PAUSED";
    if (o.status !== "ACTIVE") return o.status;
    const review = getScenario().adsReview;
    return review === "pending" ? "PENDING_REVIEW" : review === "disapproved" ? "DISAPPROVED" : "ACTIVE";
  };

  const repr = (kind, o) => {
    const base = { id: o.id, name: o.name, status: o.status, effective_status: effective(kind, o) };
    if (kind === "campaign") {
      return { ...base, objective: o.objective, ...(o.daily_budget ? { daily_budget: String(o.daily_budget) } : {}), ...(o.lifetime_budget ? { lifetime_budget: String(o.lifetime_budget) } : {}) };
    }
    if (kind === "adset") {
      return {
        ...base,
        campaign_id: o.campaign_id,
        optimization_goal: o.optimization_goal,
        ...(o.daily_budget ? { daily_budget: String(o.daily_budget) } : {}),
        ...(o.lifetime_budget ? { lifetime_budget: String(o.lifetime_budget) } : {}),
        ...(o.end_time ? { end_time: iso(o.end_time) } : {}),
      };
    }
    return { ...base, adset_id: o.adset_id, campaign_id: db.adsets.get(o.adset_id)?.campaign_id };
  };
  const pick = (obj, fields) => {
    if (!fields) return obj;
    const wanted = new Set(["id", ...fields.split(",")]);
    return Object.fromEntries(Object.entries(obj).filter(([k]) => wanted.has(k)));
  };

  const params = (body) => Object.fromEntries([...body.fields.entries()].filter(([k]) => k !== "access_token" && k !== "appsecret_proof"));

  /** Atiende una llamada a la Marketing API. Devuelve true si la atendio (ya respondio). */
  async function handle({ req, res, path, p, arg, body, token }) {
    const act = path.match(/^act_(\d+)\/(campaigns|adsets|adcreatives|adimages|ads)$/);
    const obj = path.match(/^(12\d{6,})$/);
    const search = path === "search";
    if (!act && !obj && !search) return false;

    const fail = (status, code, message, extra) => graphError(res, status, code, message, extra);
    const reject = (message, code = 100, extra) => {
      fail(400, code, message, extra);
      return true;
    };
    const inject = (step) => {
      const f = FAILURES[getScenario().adsFail?.[step]];
      if (f) {
        f(fail);
        return true;
      }
      return false;
    };
    // Crear y administrar anuncios se hace con el token de la persona (no con el de una pagina).
    if (token !== userToken) {
      fail(403, 200, "(#200) Requires ads_management permission to manage the object");
      return true;
    }

    // ---------------------------------------------------------- busquedas
    if (search && req.method === "GET") {
      if (inject("search")) return true;
      const q = (p.get("q") ?? "").toLowerCase();
      if (p.get("type") === "adinterest") return json(res, 200, { data: FAKE_INTERESTS.filter((i) => i.name.toLowerCase().includes(q)) }), true;
      if (p.get("type") === "adgeolocation") return json(res, 200, { data: FAKE_CITIES.filter((c) => c.name.toLowerCase().includes(q)) }), true;
      return reject("(#100) Unsupported search type");
    }

    // ---------------------------------------------------------- crear
    if (act && req.method === "POST") {
      const account = act[1];
      const kind = act[2];
      const status = arg("status");

      if (kind === "adimages") {
        if (inject("adimage")) return true;
        const file = [...body.files.values()][0];
        if (!file) return reject("(#100) The parameter filename is required");
        const hash = sha(file.bytes).slice(0, 32);
        db.images.set(hash, { account, name: file.name, bytes: file.bytes.length });
        db.log.push({ op: "create_image", hash, bytes: file.bytes.length });
        return json(res, 200, { images: { [file.name]: { hash, url: `https://fake.meta.test/${hash}` } } }), true;
      }

      if (kind === "campaigns") {
        if (inject("campaign")) return true;
        const objective = arg("objective");
        if (!arg("name")) return reject("(#100) Param name is required");
        if (!OBJECTIVES[objective]) return reject("(#100) Invalid parameter: objective is not a valid ODAX objective");
        let categories = null;
        try {
          categories = JSON.parse(arg("special_ad_categories") ?? "null");
        } catch {
          /* se rechaza abajo */
        }
        if (!Array.isArray(categories)) return reject("(#100) Param special_ad_categories must be an array");
        if (status !== "ACTIVE" && status !== "PAUSED") return reject("(#100) Param status must be ACTIVE or PAUSED when creating");
        const id = newId();
        db.campaigns.set(id, { id, account, name: arg("name"), objective, status });
        db.log.push({ op: "create_campaign", id, account, params: params(body) });
        return json(res, 200, { id }), true;
      }

      if (kind === "adsets") {
        if (inject("adset")) return true;
        const campaign = db.campaigns.get(arg("campaign_id"));
        if (!campaign || campaign.account !== account) return reject("(#100) Invalid parameter: campaign_id does not exist in this ad account");
        if (!arg("name")) return reject("(#100) Param name is required");
        const daily = Number(arg("daily_budget"));
        if (!Number.isInteger(daily) || daily <= 0) return reject("(#100) Param daily_budget must be a positive integer");
        const min = getScenario().adsMinBudget ?? MIN_DAILY[CURRENCY[account]] ?? 1;
        if (daily < min) return reject(`(#100) Your budget is too low. The minimum daily budget for this ad account is ${min}.`, 100, { error_subcode: 1885272 });
        if (!OBJECTIVES[campaign.objective].includes(arg("optimization_goal"))) {
          return reject("(#2490408) The optimization goal you selected is not available for the campaign objective", 100, { error_subcode: 2490408 });
        }
        if (arg("billing_event") !== "IMPRESSIONS") return reject("(#100) Invalid billing_event for this optimization goal");
        if (status !== "ACTIVE" && status !== "PAUSED") return reject("(#100) Param status must be ACTIVE or PAUSED when creating");
        let targeting;
        try {
          targeting = JSON.parse(arg("targeting") ?? "null");
        } catch {
          targeting = null;
        }
        const geo = targeting?.geo_locations;
        if (!geo || (!(geo.countries?.length > 0) && !(geo.cities?.length > 0))) return reject("(#100) targeting.geo_locations needs at least one country or city");
        // v26: con segmentacion restringida, advantage_audience debe declararse en 0 o 1.
        if (![0, 1].includes(targeting.targeting_automation?.advantage_audience)) {
          return reject("(#100) Param targeting_automation.advantage_audience must be explicitly set to 0 or 1");
        }
        // v26: el placement Explorar de Instagram ya no existe.
        if (/explore/i.test(JSON.stringify(targeting))) return reject("(#100) The Instagram Explore placement is no longer available");
        if (campaign.objective === "OUTCOME_ENGAGEMENT" && arg("destination_type") === "ON_POST") {
          let promoted = null;
          try {
            promoted = JSON.parse(arg("promoted_object") ?? "null");
          } catch {
            /* se rechaza abajo */
          }
          if (!promoted?.page_id) return reject("(#100) promoted_object.page_id is required for this destination");
        }
        const end = Number(arg("end_time"));
        if (!Number.isInteger(end) || end <= 0) return reject("(#100) Param end_time must be a UNIX timestamp");
        const id = newId();
        const factor = getScenario().adsBudgetFactor ?? 1;
        db.adsets.set(id, {
          id,
          account,
          campaign_id: campaign.id,
          name: arg("name"),
          status,
          daily_budget: Math.round(daily * factor),
          optimization_goal: arg("optimization_goal"),
          end_time: end,
          targeting,
        });
        db.log.push({ op: "create_adset", id, account, params: params(body) });
        return json(res, 200, { id }), true;
      }

      if (kind === "adcreatives") {
        if (inject("creative")) return true;
        if (getScenario().adsEnhancements === "required" && !arg("degrees_of_freedom_spec")) {
          return reject("(#100) Creative Must Provide enroll_status for Standard Enhancements");
        }
        if (!arg("name")) return reject("(#100) Param name is required");
        const story = arg("object_story_id");
        const igMedia = arg("source_instagram_media_id");
        const specRaw = arg("object_story_spec");
        if (story) {
          if (!/^P-[A-Za-z0-9]+_\d+$/.test(story)) return reject("(#100) Invalid parameter: object_story_id");
        } else if (igMedia) {
          if (!arg("object_id") || !arg("instagram_user_id")) return reject("(#100) object_id and instagram_user_id are required with source_instagram_media_id");
        } else if (specRaw) {
          let spec = null;
          try {
            spec = JSON.parse(specRaw);
          } catch {
            /* se rechaza abajo */
          }
          const data = spec?.link_data ?? spec?.photo_data;
          if (!spec?.page_id || !data) return reject("(#100) object_story_spec needs page_id and link_data or photo_data");
          if (!db.images.has(data.image_hash)) return reject("(#100) Invalid image_hash: the image does not exist in this ad account");
        } else {
          return reject("(#100) One of object_story_id, object_story_spec or source_instagram_media_id is required");
        }
        const id = newId();
        db.creatives.set(id, { id, account, name: arg("name") });
        db.log.push({ op: "create_creative", id, account, params: params(body) });
        return json(res, 200, { id }), true;
      }

      // ads
      if (inject("ad")) return true;
      const set = db.adsets.get(arg("adset_id"));
      if (!set || set.account !== account) return reject("(#100) Invalid parameter: adset_id");
      let creativeId = null;
      try {
        creativeId = JSON.parse(arg("creative") ?? "null")?.creative_id;
      } catch {
        /* se rechaza abajo */
      }
      if (!db.creatives.has(creativeId)) return reject("(#100) Invalid parameter: creative");
      if (status !== "ACTIVE" && status !== "PAUSED") return reject("(#100) Param status must be ACTIVE or PAUSED when creating");
      const id = newId();
      db.ads.set(id, { id, account, adset_id: set.id, name: arg("name"), creative_id: creativeId, status });
      db.log.push({ op: "create_ad", id, account, params: params(body) });
      return json(res, 200, { id }), true;
    }

    // ---------------------------------------------------------- listas de la cuenta
    if (act && req.method === "GET") {
      const account = act[1];
      const kind = act[2];
      const fields = p.get("fields");
      if (kind === "campaigns") return json(res, 200, { data: [...db.campaigns.values()].filter((o) => o.account === account && o.status !== "DELETED").map((o) => pick(repr("campaign", o), fields)) }), true;
      if (kind === "adsets") return json(res, 200, { data: [...db.adsets.values()].filter((o) => o.account === account && o.status !== "DELETED").map((o) => pick(repr("adset", o), fields)) }), true;
      if (kind === "ads") return json(res, 200, { data: [...db.ads.values()].filter((o) => o.account === account && o.status !== "DELETED").map((o) => pick(repr("ad", o), fields)) }), true;
      return reject("(#100) Unsupported get request");
    }

    // ---------------------------------------------------------- leer o cambiar un objeto
    if (obj) {
      const id = obj[1];
      const found = db.campaigns.has(id) ? ["campaign", db.campaigns.get(id)] : db.adsets.has(id) ? ["adset", db.adsets.get(id)] : db.ads.has(id) ? ["ad", db.ads.get(id)] : null;
      if (!found) return reject("(#100) Unsupported get request. Object with ID does not exist, cannot be loaded due to missing permissions, or does not support this operation", 100, { error_subcode: 33 });
      const [kind, o] = found;
      if (req.method === "GET") return json(res, 200, pick(repr(kind, o), p.get("fields"))), true;

      const status = arg("status");
      if (status) {
        if (!["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"].includes(status)) return reject("(#100) Invalid status");
        if (status === "ACTIVE" && inject("activate")) return true;
        if (status === "PAUSED" && inject("pause")) return true;
        o.status = status;
        db.log.push({ op: "status", id, kind, status });
      }
      if (arg("daily_budget")) {
        const daily = Number(arg("daily_budget"));
        if (!Number.isInteger(daily) || daily <= 0) return reject("(#100) Param daily_budget must be a positive integer");
        if (inject("budget")) return true;
        o.daily_budget = Math.round(daily * (getScenario().adsBudgetFactor ?? 1));
        db.log.push({ op: "budget", id, kind, daily_budget: daily });
      }
      if (arg("end_time")) {
        o.end_time = Number(arg("end_time"));
        db.log.push({ op: "end_time", id, kind, end_time: o.end_time });
      }
      return json(res, 200, { success: true }), true;
    }

    return reject("(#100) Unsupported request");
  }

  return {
    handle,
    reset: () => {
      db = fresh();
    },
    /** Lo que hay "en Meta" ahora mismo (para comprobar en las pruebas). */
    state: () => ({
      campaigns: [...db.campaigns.values()],
      adsets: [...db.adsets.values()],
      creatives: [...db.creatives.values()],
      ads: [...db.ads.values()],
      images: [...db.images.entries()].map(([hash, v]) => ({ hash, ...v })),
      log: db.log,
      effective: { campaign: (id) => effective("campaign", db.campaigns.get(id)), adset: (id) => effective("adset", db.adsets.get(id)), ad: (id) => effective("ad", db.ads.get(id)) },
    }),
    /**
     * Crea "en Meta" una campaña con sus conjuntos y anuncios, como si alguien la hubiera hecho en el Administrador de
     * anuncios: {account, name, objective, status, daily_budget?, lifetime_budget?, adsets:[{name,status,daily_budget?,lifetime_budget?,ads:[{name,status}]}]}.
     */
    seed: (spec) => {
      const cid = newId();
      db.campaigns.set(cid, { id: cid, account: spec.account, name: spec.name, objective: spec.objective ?? "OUTCOME_TRAFFIC", status: spec.status ?? "PAUSED", daily_budget: spec.daily_budget, lifetime_budget: spec.lifetime_budget });
      const out = { campaign: cid, adsets: [], ads: [] };
      for (const s of spec.adsets ?? []) {
        const sid = newId();
        db.adsets.set(sid, { id: sid, account: spec.account, campaign_id: cid, name: s.name, status: s.status ?? "PAUSED", daily_budget: s.daily_budget, lifetime_budget: s.lifetime_budget, optimization_goal: "LINK_CLICKS", end_time: s.end_time });
        out.adsets.push(sid);
        for (const a of s.ads ?? []) {
          const aid = newId();
          db.ads.set(aid, { id: aid, account: spec.account, adset_id: sid, name: a.name, creative_id: null, status: a.status ?? "PAUSED" });
          out.ads.push(aid);
        }
      }
      return out;
    },
  };
}
