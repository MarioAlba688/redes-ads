import { ADS_WRITE_SCOPE, missingAdsWriteScope, missingPublishScope, missingStatsScopes, PUBLISH_SCOPE, STATS_SCOPE } from "@/lib/meta/scopes";

// Diagnostico de la configuracion de Meta (Facebook e Instagram) para la pagina Manual. Logica pura, sin servidor ni
// base de datos: recibe lo que la pagina ya leyo y devuelve una lista de comprobaciones con su estado y que hacer.

export type CheckStatus = "ok" | "warn" | "todo";

export type DiagnosticCheck = {
  id: string;
  status: CheckStatus;
  title: string;
  /** Que pasa y, si no esta bien, que hacer. */
  detail: string;
  /** Seccion del manual (#ancla) donde esta el paso para arreglarlo. */
  anchor?: string;
};

export type DiagnosticAccount = {
  kind: string;
  name: string;
  scopes: string | null;
  /** Cuentas publicitarias: tope de gasto diario por anuncio fijado por el administrador (null = sin fijar). */
  dailyBudgetCap?: number | null;
};

export type DiagnosticInput = {
  /** Estan META_APP_ID y META_APP_SECRET en el servidor. */
  configured: boolean;
  /** Permisos que se piden al conectar (META_SCOPES o la lista por defecto). */
  scopes: readonly string[];
  /** Cuentas de Meta conectadas y no desconectadas: paginas, Instagram y cuentas publicitarias. */
  accounts: readonly DiagnosticAccount[];
  appUrl: string;
  /** MEDIA_PUBLIC_BASE_URL, si esta definida. */
  mediaBaseUrl: string | null;
  /** Imagenes registradas en la base de datos (las mas recientes) y cuantas no estan en la carpeta de medios de este servidor. */
  media?: { total: number; missing: number };
};

const IG_SCOPES = ["instagram_basic", PUBLISH_SCOPE.INSTAGRAM_PROFILE] as const;
/** Permisos que se piden al conectar para leer las estadisticas de lo publicado (instagram_basic ya va con los de publicar). */
const STATS_REQUESTED = [
  STATS_SCOPE.FACEBOOK_PAGE.basic,
  STATS_SCOPE.FACEBOOK_PAGE.insights,
  STATS_SCOPE.FACEBOOK_PAGE.content,
  STATS_SCOPE.INSTAGRAM_PROFILE.insights,
] as const;

/** Textos de ejemplo que alguien pudo copiar tal cual del manual o de una guia en lugar de poner su direccion real. */
const PLACEHOLDER_HOST = /palabras-al-azar|tu-direccion|tu-dominio|tudominio|ejemplo|example\.|nombre-raro/i;

/** Nombres para una frase: los primeros `max` y «y N más» (una cuenta puede tener decenas de cuentas publicitarias). */
export function nameList(names: readonly string[], max = 5): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} y ${names.length - max} más`;
}

export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname.endsWith(".local");
}

/** ¿Podra Instagram descargar las imagenes desde la direccion publica configurada? */
export function publicImageCheck(appUrl: string, mediaBaseUrl: string | null): { ok: boolean; detail: string } {
  const target = mediaBaseUrl ?? appUrl;
  const source = mediaBaseUrl ? "MEDIA_PUBLIC_BASE_URL" : "APP_URL";
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, detail: `${source} no es una dirección válida.` };
  }
  if (PLACEHOLDER_HOST.test(url.hostname)) {
    return {
      ok: false,
      detail: `${source} es «${url.origin}», que parece el ejemplo del manual y no una dirección real. Pon la que te muestra tu túnel o tu dominio.`,
    };
  }
  if (url.protocol !== "https:") return { ok: false, detail: `${source} (${url.origin}) no usa HTTPS: Instagram solo descarga imágenes por HTTPS.` };
  if (isLocalHost(url.hostname)) return { ok: false, detail: `${source} (${url.origin}) es una dirección local: Instagram no puede llegar a ella desde internet.` };
  return { ok: true, detail: `Instagram descargará las imágenes desde ${url.origin}.` };
}

export function buildMetaDiagnostics(input: DiagnosticInput): DiagnosticCheck[] {
  const { accounts } = input;
  const pages = accounts.filter((a) => a.kind === "FACEBOOK_PAGE");
  const instagram = accounts.filter((a) => a.kind === "INSTAGRAM_PROFILE");
  const checks: DiagnosticCheck[] = [];

  checks.push(
    input.configured
      ? { id: "app", status: "ok", title: "La app de Meta está configurada en el servidor", detail: "Están META_APP_ID y META_APP_SECRET." }
      : {
          id: "app",
          status: "todo",
          title: "Falta configurar la app de Meta en el servidor",
          detail: "Crea la app en Meta for Developers y pon META_APP_ID y META_APP_SECRET en el archivo .env (pasos 2 y 3).",
          anchor: "crear-app",
        },
  );

  const missingFb = input.scopes.includes(PUBLISH_SCOPE.FACEBOOK_PAGE) ? [] : [PUBLISH_SCOPE.FACEBOOK_PAGE];
  const missingIg = IG_SCOPES.filter((s) => !input.scopes.includes(s));
  const missingAll = [...missingFb, ...missingIg];
  checks.push(
    missingAll.length === 0
      ? { id: "scopes", status: "ok", title: "Se piden los permisos para publicar en Facebook e Instagram", detail: "META_SCOPES incluye pages_manage_posts, instagram_basic e instagram_content_publish." }
      : {
          id: "scopes",
          status: "warn",
          title: "No se están pidiendo todos los permisos para publicar",
          detail: `Faltan en META_SCOPES: ${missingAll.join(", ")}. Agrégalos (o quita la variable) cuando tu app de Meta los tenga habilitados, y reconecta.`,
          anchor: "servidor",
        },
  );

  checks.push(
    pages.length > 0
      ? { id: "pages", status: "ok", title: `${pages.length} página(s) de Facebook conectada(s)`, detail: pages.map((p) => p.name).join(", ") }
      : { id: "pages", status: "todo", title: "Todavía no hay páginas de Facebook conectadas", detail: "Pulsa «Conectar Meta» en Cuentas y marca tus páginas (paso 4).", anchor: "conectar" },
  );

  const blocked = [...pages, ...instagram].filter((a) => missingPublishScope(a.kind, a.scopes) !== null);
  if (pages.length + instagram.length > 0) {
    checks.push(
      blocked.length === 0
        ? { id: "publish", status: "ok", title: "Las cuentas conectadas tienen permiso para publicar", detail: "La conexión incluye el permiso de publicar de cada una." }
        : {
            id: "publish",
            status: "warn",
            title: `${blocked.length} cuenta(s) conectada(s) sin permiso para publicar`,
            detail: `${blocked.map((a) => a.name).join(", ")}. Sin ese permiso la app no deja aprobar ni publicar. Agrégalo en tu app de Meta y pulsa «Reconectar Meta».`,
            anchor: "permisos",
          },
    );
  }

  const statsNotRequested = STATS_REQUESTED.filter((s) => !input.scopes.includes(s));
  const noStats = [...pages, ...instagram].filter((a) => {
    const m = missingStatsScopes(a.kind, a.scopes);
    return m.basic !== null || m.insights !== null || m.content !== null;
  });
  if (statsNotRequested.length > 0) {
    checks.push({
      id: "estadisticas",
      status: "warn",
      title: "No se están pidiendo todos los permisos de estadísticas",
      detail: `Faltan en META_SCOPES: ${statsNotRequested.join(", ")}. Sin ellos no se leen las vistas, el alcance ni las reacciones de tus publicaciones. Agrégalos cuando tu app de Meta los tenga habilitados, y reconecta.`,
      anchor: "estadisticas",
    });
  } else if (noStats.length > 0) {
    checks.push({
      id: "estadisticas",
      status: "warn",
      title: `${noStats.length} cuenta(s) conectada(s) sin permiso para leer estadísticas`,
      detail: `${noStats.map((a) => a.name).join(", ")}. Agrega el permiso en tu app de Meta y pulsa «Reconectar Meta»; hasta entonces esas cuentas no muestran todas sus cifras.`,
      anchor: "estadisticas",
    });
  } else {
    checks.push({
      id: "estadisticas",
      status: "ok",
      title: "Se pueden leer las estadísticas de las publicaciones",
      detail: pages.length + instagram.length > 0 ? "Las cuentas conectadas tienen los permisos para leer vistas, alcance e interacciones." : "META_SCOPES incluye los permisos de estadísticas.",
    });
  }

  // --- crear y administrar anuncios ---
  const adAccounts = accounts.filter((a) => a.kind === "AD_ACCOUNT");
  const adsNoScope = adAccounts.filter((a) => missingAdsWriteScope(a.scopes) !== null);
  const adsNoCap = adAccounts.filter((a) => a.dailyBudgetCap === null || a.dailyBudgetCap === undefined);
  if (!input.scopes.includes(ADS_WRITE_SCOPE)) {
    checks.push({
      id: "anuncios",
      status: "warn",
      title: "No se está pidiendo el permiso para crear anuncios",
      detail: `Falta ${ADS_WRITE_SCOPE} en META_SCOPES: con ads_read solo se pueden ver las cifras. Agrégalo cuando tu app de Meta lo tenga habilitado, y reconecta.`,
      anchor: "anuncios",
    });
  } else if (adsNoScope.length > 0) {
    checks.push({
      id: "anuncios",
      status: "warn",
      title: `${adsNoScope.length} cuenta(s) publicitaria(s) sin permiso para crear anuncios`,
      detail: `${nameList(adsNoScope.map((a) => a.name))}. Agrega ${ADS_WRITE_SCOPE} en tu app de Meta y pulsa «Reconectar Meta»; hasta entonces solo se ven sus cifras.`,
      anchor: "anuncios",
    });
  } else if (adsNoCap.length > 0) {
    checks.push({
      id: "anuncios",
      status: "todo",
      title: `${adsNoCap.length} cuenta(s) publicitaria(s) sin tope de gasto diario`,
      detail: `${nameList(adsNoCap.map((a) => a.name))}. Fija el tope en Cuentas: sin él no se pueden crear ni activar anuncios desde la app.`,
      anchor: "anuncios",
    });
  } else {
    checks.push({
      id: "anuncios",
      status: "ok",
      title: "Se pueden crear anuncios",
      detail: adAccounts.length > 0 ? "Las cuentas publicitarias tienen el permiso y su tope de gasto diario." : "META_SCOPES incluye el permiso para crear anuncios.",
    });
  }

  checks.push(
    instagram.length > 0
      ? { id: "instagram", status: "ok", title: `${instagram.length} cuenta(s) de Instagram conectada(s)`, detail: instagram.map((a) => a.name).join(", ") }
      : {
          id: "instagram",
          status: "todo",
          title: "Todavía no hay cuentas de Instagram conectadas",
          detail:
            missingIg.length > 0
              ? `Falta pedir ${missingIg.join(" e ")} en META_SCOPES y que tu app de Meta los tenga habilitados (paso 2). Además la cuenta debe ser profesional y estar vinculada a la página.`
              : "La cuenta de Instagram debe ser profesional (Empresa) y estar vinculada a la página de Facebook; luego pulsa «Reconectar Meta» y marca también la cuenta de Instagram.",
          anchor: "instagram",
        },
  );

  // Los archivos de las imagenes viven en el disco de cada servidor; la base de datos puede ser compartida.
  if (input.media && input.media.total > 0) {
    const { total, missing } = input.media;
    checks.push(
      missing === 0
        ? { id: "archivos", status: "ok", title: "Las imágenes están en la carpeta de este servidor", detail: `Las ${total} imágenes registradas más recientes tienen su archivo.` }
        : {
            id: "archivos",
            status: "warn",
            title: `${missing} de ${total} imágenes registradas no están en la carpeta de este servidor`,
            detail:
              "Pasa si el servidor se redespliega sin un volumen para MEDIA_DIR, o si esas publicaciones se crearon en otra copia de la app que usa la misma base de datos. Esas publicaciones no pueden mostrar su imagen ni usarse en un anuncio nuevo: vuelve a subirla. Para que no se repita, pon MEDIA_DIR en un volumen que sobreviva a los despliegues.",
            anchor: "problemas",
          },
    );
  }

  const image = publicImageCheck(input.appUrl, input.mediaBaseUrl);
  checks.push({
    id: "imagenes",
    status: image.ok ? "ok" : "warn",
    title: image.ok ? "Instagram podrá descargar las imágenes" : "Instagram no podrá descargar las imágenes todavía",
    detail: image.ok ? image.detail : `${image.detail} Facebook sí publica con la app en tu PC; Instagram necesita una dirección pública con HTTPS (paso 6).`,
    anchor: "publicar-instagram",
  });

  return checks;
}
