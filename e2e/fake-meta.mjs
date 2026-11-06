// Servidor que imita a Meta (facebook.com + graph.facebook.com) para las pruebas.
// Sirve el cuadro de permisos, el cambio de tokens, /me, /me/adaccounts, /me/accounts e insights,
// y valida lo que Meta valida: client_secret, redirect_uri, access_token y appsecret_proof.

import { createHash, createHmac } from "node:crypto";
import http from "node:http";
import { createAdsSimulator } from "./fake-meta-ads.mjs";

export const APP_ID = "123456789012345";
export const APP_SECRET = "secreto-de-prueba-de-la-app-meta";
export const VERSION = "v26.0";

export const SHORT_TOKEN = "SHORT-TOKEN-0001";
export const LONG_TOKEN = "LONG-TOKEN-AAAA";
export const PAGE_TOKEN = "PAGE-TOKEN-1111";
export const GOOD_CODE = "GOOD-CODE-123";

export const ACCOUNTS = [
  { account_id: "1001", name: "Tienda Principal", currency: "USD", timezone_name: "America/Bogota", account_status: 1, factor: 1 },
  { account_id: "1002", name: "Tienda Colombia", currency: "COP", timezone_name: "America/Bogota", account_status: 1, factor: 4000 },
];
export const CAMPAIGNS = [
  { id: "C-1", name: "Ventas Octubre" },
  { id: "C-2", name: "Remarketing" },
];

const dayNumber = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

/** Cifras deterministas de una campaña un dia: la prueba calcula lo mismo para comparar. */
export function insightFor(account, date, campaignIdx) {
  const base = 10 + ((dayNumber(date) + campaignIdx * 3) % 7) * 2 + campaignIdx * 5;
  const spendCents = Math.round((base * account.factor + 0.37) * 100);
  const impressions = base * 100;
  const clicks = Math.round(base * 1.5);
  return { spendCents, spend: (spendCents / 100).toFixed(2), impressions, clicks, reach: Math.round(impressions * 0.8) };
}

const PAGES = [
  { id: "P-1", name: "Mi Marca", access_token: PAGE_TOKEN, instagram_business_account: { id: "IG-1", username: "mimarca", name: "Mi Marca Oficial" } },
  { id: "P-2", name: "Otra Página", access_token: "PAGE-TOKEN-2222" },
];

// Escenario "bulk": una persona con muchas cuentas (como un portafolio comercial): 22 cuentas
// publicitarias extra (una repetida y otra con un nombre de 300 caracteres) y 13 paginas extra.
const BULK_ADS = Array.from({ length: 22 }, (_, i) => ({
  account_id: String(2000 + i),
  name: i === 5 ? "N".repeat(300) : `Cuenta extra ${i}`,
  currency: "USD",
  timezone_name: "America/Bogota",
  account_status: 1,
  factor: 1,
}));
const BULK_PAGES = Array.from({ length: 13 }, (_, i) => ({
  id: `P-X${i}`,
  name: `Página extra ${i}`,
  access_token: `PAGE-TOKEN-X${i}`,
  ...(i % 4 === 0 ? { instagram_business_account: { id: `IG-X${i}`, username: `extra${i}` } } : {}),
}));
const GENERIC_ACCOUNT = (id) => ({ account_id: id, currency: "USD", timezone_name: "America/Bogota", factor: 1 });

const DEFAULT_SCENARIO = {
  assets: "base", // base | bulk
  dialog: "approve", // approve | deny | badstate
  perms: "all", // all | noads
  tokens: "valid", // valid | expired (todas las llamadas con token responden error 190)
  insights: "ok", // ok | ratelimit1002 (la cuenta 1002 responde "demasiadas llamadas")
  // --- publicacion ---
  publishFail: {}, // { "P-1": "perm" } la cuenta (id externo) responde ese error al publicar: perm | auth | rate | server | spam | dup
  flaky: {}, // { "P-1": 2 } las proximas N publicaciones de esa cuenta fallan con error 500 y luego funciona
  igProcessing: 0, // cuantas consultas del contenedor de Instagram responden IN_PROGRESS antes de FINISHED
  igContainer: "ok", // ok | error (el contenedor termina en ERROR)
  storiesList: "ok", // ok | fail: el listado de historias de la pagina (GET <pagina>/stories) responde error (la app usa entonces el enlace de la pagina)
  // --- video (Reels e historias con video) ---
  videoProcessing: 0, // cuantas consultas de estado de un video (contenedor de Instagram o video de Facebook) responden "procesando" antes de terminar
  videoFail: null, // null | "ig" (el contenedor de video termina en ERROR) | "fb" (Facebook rechaza el video al procesarlo)
  videoPublishFail: null, // null | "server" (el paso que publica responde 500 SIN haber publicado) | "server-after" (publica y luego responde 500: Meta no deja claro si salio)
  // --- estadisticas de lo publicado ---
  stats: "ok", // ok | noinsights (sin permiso de insights) | nousercontent (sin pages_read_user_content: leer reacciones/comentarios da error) | badmetric (Meta retiro una metrica) | ratelimit (limite de uso) | gone (la publicacion ya no existe) | hidelikes (Instagram sin like_count)
  statsBoost: 0, // se suma a todas las cifras: sirve para comprobar que una nueva lectura las actualiza
  // --- anuncios (Marketing API; ver fake-meta-ads.mjs) ---
  adsFail: {}, // { campaign: "perm" } ese paso responde ese error: perm | auth | rate | server | payment | invalid. Pasos: campaign, adset, creative, ad, adimage, activate, pause, budget, search
  adsBudgetFactor: 1, // Meta guarda el presupuesto multiplicado por esto (100 simula una conversion de moneda mal hecha)
  adsReview: "ok", // ok | pending (en revision) | disapproved: estado efectivo de un anuncio activo
  adsEnhancements: "ok", // required: el creativo pide decidir sobre las «mejoras estandar»
  adsMinBudget: null, // presupuesto diario minimo (unidades minimas); null = el de la moneda
};

// Cifras deterministas de una publicacion segun su numero (el final de su id): la prueba calcula lo mismo para comparar.
export function fbStatsFor(n, boost = 0) {
  return { reactions: 10 + 3 * n + boost, comments: 2 + n + boost, shares: (n % 3) + boost, views: 500 + 40 * n + 10 * boost, reach: 300 + 25 * n + 5 * boost };
}
export function igStatsFor(n, boost = 0) {
  return { likes: 20 + 2 * n + boost, comments: 1 + n + boost, reach: 200 + 20 * n + 4 * boost, views: 400 + 35 * n + 8 * boost, saved: n + boost, shares: (n % 2) + boost };
}

// Token que Meta acepta para publicar en cada pagina / cuenta de Instagram.
const OWNER_TOKEN = { "P-1": PAGE_TOKEN, "IG-1": PAGE_TOKEN, "P-2": "PAGE-TOKEN-2222" };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Mira un MP4/MOV como lo haria Meta: ¿empieza con ftyp?, ¿el indice (moov) esta antes de los datos (mdat)? */
export function isoVideoInfo(bytes) {
  let offset = 0;
  let ftyp = false;
  let moov = -1;
  let mdat = -1;
  let first = true;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (size === 1 && offset + 16 <= bytes.length) size = Number(bytes.readBigUInt64BE(offset + 8));
    else if (size === 0) size = bytes.length - offset;
    if (size < 8 || offset + size > bytes.length) return { ok: false, truncated: true };
    if (first) {
      if (type !== "ftyp") return { ok: false, truncated: false };
      ftyp = true;
      first = false;
    }
    if (type === "moov" && moov < 0) moov = offset;
    if (type === "mdat" && mdat < 0) mdat = offset;
    offset += size;
  }
  return { ok: ftyp && moov >= 0 && mdat >= 0, truncated: false, fastStart: moov >= 0 && mdat >= 0 && moov < mdat };
}

/** Errores que Meta devuelve al publicar (codigos reales de la Graph API). */
const PUBLISH_FAILURES = {
  perm: (fail) => fail(403, 200, "(#200) The user hasn't authorized the application to perform this action"),
  auth: (fail) => fail(400, 190, "Error validating access token: The session has been invalidated because the user changed their password.", { error_subcode: 460 }),
  rate: (fail) => fail(400, 4, "(#4) Application request limit reached"),
  server: (fail) => fail(500, 2, "An unexpected error has occurred. Please retry your request later."),
  spam: (fail) => fail(400, 368, "The action attempted has been deemed abusive or is otherwise disallowed"),
  dup: (fail) => fail(400, 506, "Duplicate status message"),
};

/** Cuerpo de un POST (formulario normal o multipart): campos de texto y archivos. */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request("http://fake.local/", {
    method: "POST",
    headers: { "content-type": req.headers["content-type"] ?? "application/x-www-form-urlencoded" },
    body: Buffer.concat(chunks),
  });
  const form = await request.formData();
  const fields = new Map();
  const files = new Map();
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields.set(key, value);
    else files.set(key, { name: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) });
  }
  return { fields, files };
}

export function startFakeMeta(port, expectedRedirectUri) {
  let scenario = { ...DEFAULT_SCENARIO };
  let requests = [];
  let lastDialog = null;
  let published = []; // lo que "salio" en Facebook / Instagram
  let containers = new Map(); // contenedores de Instagram creados
  let unpublishedPhotos = new Map(); // fotos subidas con published=false (para adjuntarlas a una publicacion o a una historia)
  let stories = []; // historias de pagina creadas (GET <pagina>/stories las lista)
  let fbVideos = new Map(); // videos de Facebook (Reels e historias): sesion de subida, bytes recibidos y estado
  let uploads = []; // subidas de bytes a "rupload" (lo que llego, con que cabeceras)
  let seq = 0;

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const graphError = (res, status, code, message, extra = {}) =>
    json(res, status, { error: { message, type: code === 190 ? "OAuthException" : "GraphMethodException", code, fbtrace_id: "FAKE", ...extra } });

  const ads = createAdsSimulator({ getScenario: () => scenario, graphError, json, userToken: LONG_TOKEN });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.searchParams;

    // --- control de la prueba ---
    if (url.pathname === "/__scenario" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      scenario = { ...scenario, ...JSON.parse(raw || "{}") };
      return json(res, 200, scenario);
    }
    if (url.pathname === "/__reset") {
      ads.reset();
      scenario = { ...DEFAULT_SCENARIO };
      requests = [];
      lastDialog = null;
      published = [];
      containers = new Map();
      unpublishedPhotos = new Map();
      stories = [];
      fbVideos = new Map();
      uploads = [];
      return json(res, 200, {});
    }
    if (url.pathname === "/__requests") return json(res, 200, { requests, lastDialog });
    if (url.pathname === "/__published") return json(res, 200, { published });
    if (url.pathname === "/__uploads") return json(res, 200, { uploads });

    // --- subida de los bytes de un video a Facebook (rupload.facebook.com): el token va en la cabecera Authorization ---
    if (req.method === "POST" && url.pathname.startsWith(`/rupload/video-upload/${VERSION}/`)) {
      const id = url.pathname.split("/").pop();
      const rec = fbVideos.get(id);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const bad = (status, message, type = "ProcessingFailedError") => json(res, status, { debug_info: { retriable: false, type, message } });
      if (!rec) return bad(404, "Unknown video upload session");
      const auth = req.headers.authorization ?? "";
      const size = Number(req.headers.file_size);
      const offset = Number(req.headers.offset ?? -1);
      uploads.push({ video: id, account: rec.account, authOk: auth === `OAuth ${OWNER_TOKEN[rec.account]}`, tokenInUrl: url.search.includes("token"), offset, fileSize: size, received: bytes.length, contentType: req.headers["content-type"] ?? null, sha256: sha256(bytes) });
      if (auth !== `OAuth ${OWNER_TOKEN[rec.account]}`) return bad(401, "Invalid OAuth access token", "OAuthException");
      if (offset !== 0 || !Number.isFinite(size) || bytes.length !== size) return bad(400, `Partial request: received ${bytes.length} of ${size} bytes`, "PartialRequestError");
      const info = isoVideoInfo(bytes);
      if (!info.ok) return bad(400, "The uploaded file is not a valid video");
      Object.assign(rec, { uploaded: true, size, received: bytes.length, sha256: sha256(bytes), fastStart: info.fastStart });
      return json(res, 200, { success: true });
    }

    // --- cuadro de permisos de Facebook (navegador) ---
    if (url.pathname === `/${VERSION}/dialog/oauth`) {
      lastDialog = Object.fromEntries(p);
      requests.push({ path: "dialog/oauth" });
      if (p.get("client_id") !== APP_ID) return json(res, 400, { error: { message: "Invalid App ID", code: 101 } });
      if (p.get("redirect_uri") !== expectedRedirectUri) {
        return json(res, 400, { error: { message: "redirect_uri no registrado en la app", code: 191 } });
      }
      const back = new URL(p.get("redirect_uri"));
      if (scenario.dialog === "deny") {
        back.search = new URLSearchParams({ error: "access_denied", error_reason: "user_denied", error_description: "Permissions error.", state: p.get("state") }).toString();
      } else {
        back.search = new URLSearchParams({ code: GOOD_CODE, state: scenario.dialog === "badstate" ? "estado-falso" : p.get("state") }).toString();
      }
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    // --- intercambio de tokens (servidor a servidor) ---
    if (url.pathname === `/${VERSION}/oauth/access_token`) {
      requests.push({ path: "oauth/access_token", grant: p.get("grant_type") ?? "code" });
      if (p.get("client_id") !== APP_ID || p.get("client_secret") !== APP_SECRET) {
        return graphError(res, 400, 101, "Invalid client_secret");
      }
      if (p.get("grant_type") === "fb_exchange_token") {
        if (p.get("fb_exchange_token") !== SHORT_TOKEN) return graphError(res, 400, 190, "Invalid token to exchange");
        return json(res, 200, { access_token: LONG_TOKEN, token_type: "bearer", expires_in: 5_183_944 });
      }
      if (p.get("code") !== GOOD_CODE) return graphError(res, 400, 100, "This authorization code has been used or is invalid");
      if (p.get("redirect_uri") !== expectedRedirectUri) return graphError(res, 400, 100, "redirect_uri mismatch");
      return json(res, 200, { access_token: SHORT_TOKEN, token_type: "bearer", expires_in: 5400 });
    }

    // --- llamadas autenticadas ---
    const match = url.pathname.match(new RegExp(`^/${VERSION}/(.+)$`));
    if (!match) return json(res, 404, { error: { message: "Unknown path", code: 803 } });
    const path = match[1];
    // Al publicar (POST) el token y la prueba viajan en el cuerpo, no en la URL.
    const body = req.method === "POST" ? await readBody(req) : null;
    const arg = (key) => (body ? body.fields.get(key) : p.get(key)) ?? null;
    const token = arg("access_token");
    const proof = arg("appsecret_proof");
    const entry = {
      path,
      method: req.method,
      token,
      tokenInUrl: p.has("access_token") || p.has("appsecret_proof"),
      proofOk: !!token && proof === createHmac("sha256", APP_SECRET).update(token).digest("hex"),
    };
    requests.push(entry);

    if (!token) return graphError(res, 400, 104, "An access token is required");
    if (!entry.proofOk) return graphError(res, 400, 100, "Invalid appsecret_proof provided in the API argument");
    if (scenario.tokens === "expired") return graphError(res, 400, 190, "Error validating access token: Session has expired", { error_subcode: 463 });
    if (![LONG_TOKEN, PAGE_TOKEN, "PAGE-TOKEN-2222"].includes(token)) return graphError(res, 400, 190, "Invalid OAuth access token");

    if (path === "me") return json(res, 200, { id: "USER-1", name: "Mario Alba" });

    if (path === "me/permissions") {
      const all = ["ads_read", "ads_management", "pages_show_list", "pages_read_engagement", "pages_read_user_content", "pages_manage_posts", "read_insights", "instagram_basic", "instagram_content_publish", "instagram_manage_insights"];
      return json(res, 200, {
        data: all.map((permission) => ({ permission, status: scenario.perms === "noads" && permission === "ads_read" ? "declined" : "granted" })),
      });
    }

    if (path === "me/adaccounts") {
      if (scenario.perms === "noads") return graphError(res, 403, 200, "(#200) Requires ads_read permission");
      // Pocas por pagina, para ejercitar la paginacion por cursor (base: de a una; bulk: de a 6, con una repetida al final).
      const bulk = scenario.assets === "bulk";
      const list = bulk ? [...ACCOUNTS, ...BULK_ADS, ACCOUNTS[0]] : ACCOUNTS;
      const size = bulk ? 6 : 1;
      const idx = p.get("after") ? Number(p.get("after")) : 0;
      const data = list.slice(idx, idx + size).map((a) => ({ account_id: a.account_id, name: a.name, currency: a.currency, timezone_name: a.timezone_name, account_status: a.account_status }));
      const hasNext = idx + size < list.length;
      return json(res, 200, {
        data,
        paging: { cursors: { before: String(idx), after: String(idx + size) }, ...(hasNext ? { next: "https://graph.facebook.com/siguiente-pagina-no-debe-usarse" } : {}) },
      });
    }

    if (path === "me/accounts") return json(res, 200, { data: scenario.assets === "bulk" ? [...PAGES, ...BULK_PAGES] : PAGES });

    // --- anuncios (campañas, conjuntos, creativos, anuncios, imagenes y busquedas) ---
    if (await ads.handle({ req, res, path, p, arg, body, token })) return;

    // --- publicar en una pagina de Facebook o una cuenta de Instagram ---
    if (req.method === "POST") {
      const m = path.match(/^([^/]+)\/(feed|photos|photo_stories|media|media_publish|video_reels|video_stories)$/);
      if (!m) return graphError(res, 404, 803, `Unknown path components: ${path}`);
      const [, accountId, edge] = m;
      if (OWNER_TOKEN[accountId] !== token) {
        return graphError(res, 403, 200, "(#200) The user hasn't authorized the application to perform this action");
      }
      if (edge !== "media_publish") {
        const fail = (status, code, message, extra) => graphError(res, status, code, message, extra);
        const flaky = scenario.flaky[accountId] ?? 0;
        if (flaky > 0) {
          scenario.flaky = { ...scenario.flaky, [accountId]: flaky - 1 };
          return PUBLISH_FAILURES.server(fail);
        }
        const injected = PUBLISH_FAILURES[scenario.publishFail[accountId]];
        if (injected) return injected(fail);
      }

      const failWith = (status, code, message, extra) => graphError(res, status, code, message, extra);
      const sent = () => [...body.fields.keys()].filter((k) => k !== "access_token" && k !== "appsecret_proof");

      if (edge === "video_reels" || edge === "video_stories") {
        // Reel / historia con video de una pagina: abrir la subida (start), subir los bytes a rupload y finalizar (finish).
        const story = edge === "video_stories";
        const phase = arg("upload_phase");
        if (phase === "start") {
          const id = `FBV-${++seq}`;
          fbVideos.set(id, { id, account: accountId, story, uploaded: false, finished: false, polls: 0 });
          return json(res, 200, { video_id: id, upload_url: `http://127.0.0.1:${port}/rupload/video-upload/${VERSION}/${id}` });
        }
        if (phase === "finish") {
          const rec = fbVideos.get(arg("video_id") ?? "");
          if (!rec || rec.account !== accountId || rec.story !== story) return graphError(res, 400, 100, "(#100) Invalid parameter: video_id is not an open upload session of this page");
          if (!rec.uploaded) return graphError(res, 400, 100, "(#100) The video upload is not complete");
          // Meta no documenta que pasa al repetir el paso: el simulador es estricto para que un duplicado no pase desapercibido.
          if (rec.finished) return graphError(res, 400, 100, "(#100) The video was already published");
          if (scenario.videoPublishFail === "server") return PUBLISH_FAILURES.server(failWith);
          rec.finished = true;
          const record = { kind: story ? "fb-video-story" : "fb-reel", account: accountId, id: rec.id, description: arg("description"), videoState: arg("video_state"), bytes: rec.received, sha256: rec.sha256, fastStart: rec.fastStart, fields: sent() };
          let postId;
          if (story) {
            postId = `${accountId}_${++seq}`;
            record.postId = postId;
            stories.push({ account: accountId, post_id: postId, status: "PUBLISHED", media_type: "video", media_id: rec.id, url: `https://www.facebook.com/stories/${accountId}/${seq}` });
          }
          published.push(record);
          if (scenario.videoPublishFail === "server-after") return PUBLISH_FAILURES.server(failWith);
          return json(res, 200, { success: true, ...(story ? { post_id: postId } : {}) });
        }
        return graphError(res, 400, 100, "(#100) The parameter upload_phase is required");
      }

      if (edge === "feed") {
        // Varias fotos: attached_media[i] = {"media_fbid": "<foto subida con published=false a ESTA pagina>"}.
        const attachedKeys = [...body.fields.keys()].filter((k) => /^attached_media\[\d+\]$/.test(k)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
        if (attachedKeys.length) {
          const photos = attachedKeys.map((k) => {
            try {
              return unpublishedPhotos.get(JSON.parse(body.fields.get(k)).media_fbid);
            } catch {
              return undefined;
            }
          });
          if (photos.some((ph) => !ph || ph.account !== accountId)) {
            return graphError(res, 400, 100, "(#100) Invalid parameter: attached_media has a photo that was not uploaded unpublished to this page");
          }
          photos.forEach((ph) => {
            ph.used = "feed"; // una foto que ya salio en una publicacion no se puede usar en una historia
          });
          const id = `${accountId}_${++seq}`;
          published.push({ kind: "feed", account: accountId, message: arg("message"), link: arg("link"), id, attached: photos.map((ph) => ({ id: ph.id, sha256: ph.sha256, bytes: ph.bytes, name: ph.name })) });
          return json(res, 200, { id });
        }
        const id = `${accountId}_${++seq}`;
        published.push({ kind: "feed", account: accountId, message: arg("message"), link: arg("link"), id });
        return json(res, 200, { id });
      }
      if (edge === "photos") {
        const file = body.files.get("source");
        if (!file) return graphError(res, 400, 100, "(#100) The parameter source is required");
        if (arg("published") === "false") {
          // Foto suelta que no sale en la pagina: solo sirve para adjuntarla despues a una publicacion.
          const id = `UPH-${++seq}`;
          const rec = { id, account: accountId, sha256: sha256(file.bytes), bytes: file.bytes.length, name: file.name };
          unpublishedPhotos.set(id, rec);
          published.push({ kind: "photo-unpublished", ...rec, caption: arg("caption") });
          return json(res, 200, { id });
        }
        const postId = `${accountId}_${++seq}`;
        published.push({ kind: "photo", account: accountId, caption: arg("caption"), bytes: file.bytes.length, sha256: sha256(file.bytes), mime: file.type, filename: file.name, id: postId });
        return json(res, 200, { id: `photo-${seq}`, post_id: postId });
      }
      if (edge === "photo_stories") {
        // Historia de foto de una pagina: usa una foto subida SIN publicar a ESTA pagina y que no se haya usado antes.
        const photo = unpublishedPhotos.get(arg("photo_id") ?? "");
        if (!photo || photo.account !== accountId) {
          return graphError(res, 400, 100, "(#100) Invalid parameter: photo_id must be a photo uploaded unpublished to this page");
        }
        if (photo.used) return graphError(res, 400, 100, "(#100) The photo was already used in a post or a story and cannot be used in a story");
        photo.used = "story";
        const postId = `${accountId}_${++seq}`;
        stories.push({ account: accountId, post_id: postId, status: "PUBLISHED", media_type: "photo", media_id: photo.id, url: `https://www.facebook.com/stories/${accountId}/${seq}` });
        published.push({
          kind: "fb-story",
          account: accountId,
          id: postId,
          photoId: photo.id,
          sha256: photo.sha256,
          bytes: photo.bytes,
          name: photo.name,
          // Que campos mando la app (sin las credenciales): una historia no lleva mensaje, pie ni enlace.
          fields: [...body.fields.keys()].filter((k) => k !== "access_token" && k !== "appsecret_proof"),
        });
        return json(res, 200, { success: true, post_id: postId });
      }
      if (edge === "media" && arg("media_type") === "CAROUSEL") {
        // Contenedor padre del carrusel: reune de 2 a 10 contenedores hijos (is_carousel_item) de esta misma cuenta.
        const ids = (arg("children") ?? "").split(",").filter(Boolean);
        const kids = ids.map((cid) => containers.get(cid));
        if (ids.length < 2 || ids.length > 10 || kids.some((k) => !k || !k.child || k.account !== accountId)) {
          return graphError(res, 400, 100, "(#100) Invalid parameter: children must be 2 to 10 carousel item containers of this account");
        }
        const id = `CONT-${++seq}`;
        containers.set(id, { account: accountId, polls: 0, children: ids });
        published.push({ kind: "ig-carousel", account: accountId, caption: arg("caption"), id, children: ids.map((cid) => published.find((p) => p.id === cid)) });
        return json(res, 200, { id });
      }
      if (edge === "media" && arg("video_url")) {
        // Reel (media_type=REELS) o historia con video (STORIES): Meta descarga el video de la URL publica que le dimos.
        const mediaType = arg("media_type");
        if (mediaType !== "REELS" && mediaType !== "STORIES") return graphError(res, 400, 100, "(#100) media_type must be REELS or STORIES when video_url is given");
        let fetched;
        try {
          const r = await fetch(arg("video_url"));
          const bytes = Buffer.from(await r.arrayBuffer());
          const info = isoVideoInfo(bytes);
          fetched = { status: r.status, contentType: r.headers.get("content-type"), bytes: bytes.length, sha256: sha256(bytes), valid: info.ok, fastStart: info.fastStart === true };
        } catch (e) {
          fetched = { status: 0, error: String(e) };
        }
        if (fetched.status !== 200) return graphError(res, 400, 9004, "The media could not be fetched from this uri", { error_subcode: 2207052 });
        // Como Meta: otra cosa que un MP4/MOV, o con el indice (moov) al final, no se acepta.
        if (!fetched.valid || !fetched.fastStart || !String(fetched.contentType ?? "").startsWith("video/")) {
          return graphError(res, 400, 352, "The video format is not supported", { error_subcode: 2207026 });
        }
        let cover = null;
        if (arg("cover_url")) {
          try {
            const r = await fetch(arg("cover_url"));
            const b = Buffer.from(await r.arrayBuffer());
            cover = { status: r.status, contentType: r.headers.get("content-type"), bytes: b.length, sha256: sha256(b) };
          } catch (e) {
            cover = { status: 0, error: String(e) };
          }
        }
        const id = `CONT-${++seq}`;
        containers.set(id, { account: accountId, polls: 0, video: true, story: mediaType === "STORIES", published: false });
        published.push({ kind: mediaType === "REELS" ? "ig-reel" : "ig-video-story", account: accountId, caption: arg("caption"), videoUrl: arg("video_url"), coverUrl: arg("cover_url"), shareToFeed: arg("share_to_feed"), fetched, cover, id, fields: sent() });
        return json(res, 200, { id });
      }
      if (edge === "media") {
        // Historia: el contenedor lleva media_type=STORIES y una imagen (o video); el resto es igual que una publicacion.
        const isStory = arg("media_type") === "STORIES";
        if (isStory && !arg("image_url") && !arg("video_url")) {
          return graphError(res, 400, 100, "(#100) The parameter image_url or video_url is required for a story");
        }
        // Instagram descarga la imagen de la URL publica que le dimos, sin sesion: lo comprobamos igual.
        const imageUrl = arg("image_url");
        let fetched;
        try {
          const r = await fetch(imageUrl);
          const bytes = Buffer.from(await r.arrayBuffer());
          fetched = { status: r.status, contentType: r.headers.get("content-type"), bytes: bytes.length, sha256: sha256(bytes) };
        } catch (e) {
          fetched = { status: 0, error: String(e) };
        }
        if (fetched.status !== 200) {
          return graphError(res, 400, 9004, "The media could not be fetched from this uri", { error_subcode: 2207052 });
        }
        const id = `CONT-${++seq}`;
        const child = arg("is_carousel_item") === "true";
        containers.set(id, { account: accountId, polls: 0, child, story: isStory });
        published.push({ kind: child ? "ig-child" : isStory ? "ig-story" : "ig-container", account: accountId, caption: arg("caption"), imageUrl, fetched, id });
        return json(res, 200, { id });
      }
      // media_publish
      const container = containers.get(arg("creation_id"));
      if (!container || container.account !== accountId) return graphError(res, 400, 100, "(#100) Invalid creation_id");
      // Un hijo de carrusel no se publica solo: se publica el padre.
      if (container.child) return graphError(res, 400, 9007, "(#9007) The media is not ready to be published. Carousel items are published through their parent container.");
      if (container.video) {
        // Un video todavia procesandose no se puede publicar, y un contenedor ya publicado no se publica otra vez.
        if (container.polls <= scenario.videoProcessing) return graphError(res, 400, 9007, "The media is not ready for publishing, please wait for a moment", { error_subcode: 2207027 });
        if (container.published) return graphError(res, 400, 9007, "(#9007) The media container was already published", { error_subcode: 2207020 });
        if (scenario.videoPublishFail === "server") return PUBLISH_FAILURES.server(failWith);
        container.published = true;
      }
      const id = `IGM-${++seq}`;
      published.push({ kind: "ig-publish", account: accountId, creation: arg("creation_id"), id, carousel: !!container.children, story: !!container.story, video: !!container.video });
      if (container.video && scenario.videoPublishFail === "server-after") return PUBLISH_FAILURES.server(failWith);
      return json(res, 200, { id });
    }

    // --- historias que tiene una pagina (GET <pagina>/stories) ---
    const storiesMatch = path.match(/^(P-[A-Za-z0-9]+)\/stories$/);
    if (req.method === "GET" && storiesMatch) {
      if (OWNER_TOKEN[storiesMatch[1]] !== token) return graphError(res, 403, 200, "(#200) The user hasn't authorized the application to perform this action");
      if (scenario.storiesList === "fail") return graphError(res, 400, 100, "(#100) Unsupported get request");
      const data = stories
        .filter((s) => s.account === storiesMatch[1])
        .map((s) => ({ post_id: s.post_id, status: s.status, media_type: s.media_type, media_id: s.media_id, url: s.url }));
      return json(res, 200, { data });
    }

    // --- estadisticas de lo publicado (Facebook: <pagina>_<n>; Instagram: IGM-<n>) ---
    const fbPost = path.match(/^(P-[A-Za-z0-9]+)_(\d+)(\/insights)?$/);
    const igMedia = path.match(/^IGM-(\d+)(\/insights)?$/);
    const isIgStats = igMedia && (igMedia[2] || (p.get("fields") ?? "").includes("like_count"));
    if (req.method === "GET" && (fbPost || isIgStats)) {
      const accountId = fbPost ? fbPost[1] : "IG-1";
      if (OWNER_TOKEN[accountId] !== token) return graphError(res, 403, 200, "(#200) The user hasn't authorized the application to perform this action");
      if (scenario.stats === "gone") {
        return graphError(res, 400, 100, "Unsupported get request. Object with ID 'X' does not exist, cannot be loaded due to missing permissions, or does not support this operation", { error_subcode: 33 });
      }
      const boost = scenario.statsBoost;
      const wantsInsights = fbPost ? !!fbPost[3] : !!igMedia[2];
      if (!wantsInsights) {
        if (fbPost) {
          // Como Meta de verdad: pedir reacciones o comentarios sin pages_read_user_content rechaza TODA la lectura.
          if (scenario.stats === "nousercontent" && /reactions|comments/.test(p.get("fields") ?? "")) {
            return graphError(res, 403, 10, "(#10) This endpoint requires the 'pages_read_user_content' permission or the 'Page Public Content Access' feature. Refer to https://developers.facebook.com/docs/apps/review/login-permissions");
          }
          const s = fbStatsFor(Number(fbPost[2]), boost);
          return json(res, 200, {
            id: `${fbPost[1]}_${fbPost[2]}`,
            reactions: { data: [], summary: { total_count: s.reactions } },
            comments: { data: [], summary: { total_count: s.comments } },
            // Facebook omite `shares` cuando nadie compartio la publicacion.
            ...(s.shares > 0 ? { shares: { count: s.shares } } : {}),
          });
        }
        const s = igStatsFor(Number(igMedia[1]), boost);
        return json(res, 200, { id: `IGM-${igMedia[1]}`, ...(scenario.stats === "hidelikes" ? {} : { like_count: s.likes }), comments_count: s.comments });
      }
      if (scenario.stats === "noinsights") return graphError(res, 403, 10, "(#10) Application does not have permission for this action");
      if (scenario.stats === "ratelimit") return graphError(res, 400, 4, "(#4) Application request limit reached");
      const asked = (p.get("metric") ?? "").split(",").filter(Boolean);
      const values = fbPost
        ? (() => {
            const s = fbStatsFor(Number(fbPost[2]), boost);
            // El desglose por tipo de reaccion suma el total de reacciones.
            return {
              post_media_view: s.views,
              post_reactions_by_type_total: { like: s.reactions - 2, love: 2 },
              ...(scenario.stats === "badmetric" ? {} : { post_total_media_view_unique: s.reach }),
            };
          })()
        : (() => {
            const s = igStatsFor(Number(igMedia[1]), boost);
            return { reach: s.reach, views: s.views, ...(scenario.stats === "badmetric" ? {} : { saved: s.saved }), shares: s.shares };
          })();
      // Como Meta: si se pide alguna metrica que no existe, rechaza todo el pedido.
      if (asked.length === 0 || asked.some((m) => !(m in values))) return graphError(res, 400, 100, "(#100) The value must be a valid insights metric");
      return json(res, 200, { data: asked.map((name) => ({ name, period: "lifetime", values: [{ value: values[name] }], title: name, id: `${path}/${name}/lifetime` })) });
    }

    // Estado de un contenedor de Instagram y datos de lo ya publicado.
    const containerMatch = path.match(/^(CONT-\d+)$/);
    if (containerMatch) {
      const container = containers.get(containerMatch[1]);
      if (!container) return graphError(res, 400, 100, "(#100) Unsupported get request");
      container.polls++;
      // Un contenedor de video tiene sus propios escenarios (videoProcessing / videoFail); el resto, los de siempre.
      const failed = container.video ? scenario.videoFail === "ig" : scenario.igContainer === "error";
      const processing = container.video ? scenario.videoProcessing : scenario.igProcessing;
      const status_code = failed ? "ERROR" : container.polls <= processing ? "IN_PROGRESS" : "FINISHED";
      return json(res, 200, { id: containerMatch[1], status_code, ...(status_code === "ERROR" ? { status: "Error: Media upload has failed with error code 2207026" } : {}) });
    }

    // Estado de un video de Facebook (Reel o historia): subiendo -> procesando -> publicado, o error.
    const fbVideoMatch = path.match(/^(FBV-\d+)$/);
    if (req.method === "GET" && fbVideoMatch) {
      const rec = fbVideos.get(fbVideoMatch[1]);
      if (!rec || OWNER_TOKEN[rec.account] !== token) return graphError(res, 400, 100, "(#100) Unsupported get request");
      rec.polls++;
      const done = { status: "complete" };
      let status;
      if (!rec.finished) {
        status = { video_status: rec.uploaded ? "upload_complete" : "uploading", uploading_phase: { status: rec.uploaded ? "complete" : "in_progress" }, processing_phase: { status: "not_started" }, publishing_phase: { status: "not_started" } };
      } else if (scenario.videoFail === "fb") {
        status = { video_status: "error", uploading_phase: done, processing_phase: { status: "error", error: { message: "Resolution too low. Video must have a minimum resolution of 540p." } }, publishing_phase: { status: "not_started" } };
      } else if (rec.polls <= scenario.videoProcessing) {
        status = { video_status: "processing", uploading_phase: done, processing_phase: { status: "in_progress" }, publishing_phase: { status: "not_started" } };
      } else {
        status = { video_status: "ready", uploading_phase: done, processing_phase: done, publishing_phase: { status: "complete", publish_status: "published", publish_time: Math.floor(Date.now() / 1000) } };
      }
      return json(res, 200, { status, id: rec.id });
    }
    const igMediaMatch = path.match(/^(IGM-\d+)$/);
    if (igMediaMatch) {
      const rec = published.find((x) => x.id === igMediaMatch[1]);
      const permalink = rec?.story ? `https://www.instagram.com/stories/mimarca/${igMediaMatch[1]}/` : `https://www.instagram.com/p/FAKE${igMediaMatch[1]}/`;
      return json(res, 200, { id: igMediaMatch[1], permalink });
    }

    const ins = path.match(/^act_(\d+)\/insights$/);
    if (ins) {
      const account = ACCOUNTS.find((a) => a.account_id === ins[1]) ?? (ins[1].startsWith("20") && ins[1].length === 4 ? GENERIC_ACCOUNT(ins[1]) : undefined);
      if (!account) return graphError(res, 400, 100, "Unsupported get request. Object does not exist");
      if (scenario.insights === "ratelimit1002" && account.account_id === "1002") {
        return graphError(res, 400, 80004, "There have been too many calls to this ad-account. Wait a bit and try again.");
      }
      const { since, until } = JSON.parse(p.get("time_range") ?? "{}");
      const rows = [];
      for (let t = Date.parse(`${since}T00:00:00Z`); t <= Date.parse(`${until}T00:00:00Z`); t += 86_400_000) {
        const date = new Date(t).toISOString().slice(0, 10);
        CAMPAIGNS.forEach((c, ci) => {
          const v = insightFor(account, date, ci);
          rows.push({
            campaign_id: c.id,
            campaign_name: c.name,
            date_start: date,
            date_stop: date,
            spend: v.spend,
            impressions: String(v.impressions),
            clicks: String(v.clicks),
            reach: String(v.reach),
            actions: [{ action_type: "link_click", value: String(Math.max(v.clicks - 1, 0)) }],
          });
        });
      }
      // Paginas de 50 filas.
      const offset = p.get("after") ? Number(p.get("after")) : 0;
      const slice = rows.slice(offset, offset + 50);
      const more = offset + 50 < rows.length;
      return json(res, 200, { data: slice, paging: { cursors: { after: String(offset + 50) }, ...(more ? { next: "https://graph.facebook.com/otra-pagina" } : {}) } });
    }

    return graphError(res, 404, 803, `Unknown path components: ${path}`);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        close: () => new Promise((r) => server.close(() => r())),
        setScenario: (s) => {
          scenario = { ...scenario, ...s };
        },
        reset: () => {
          scenario = { ...DEFAULT_SCENARIO };
          requests = [];
          lastDialog = null;
          published = [];
          containers = new Map();
          unpublishedPhotos = new Map();
          stories = [];
          fbVideos = new Map();
          uploads = [];
          ads.reset();
        },
        ads,
        requests: () => requests,
        lastDialog: () => lastDialog,
        published: () => published,
        uploads: () => uploads,
      }),
    );
  });
}
