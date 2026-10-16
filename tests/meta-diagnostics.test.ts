import { describe, expect, it } from "vitest";
import { buildMetaDiagnostics, nameList, publicImageCheck, type DiagnosticInput } from "@/lib/meta/diagnostics";

const ALL = [
  "ads_read",
  "ads_management",
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_posts",
  "read_insights",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
];
// Lo que concedio de verdad la conexion real del usuario el 2026-10-15: anuncios y paginas, sin publicar.
const TODAY_SCOPES = "pages_show_list,ads_read,business_management,pages_read_engagement,public_profile";
const base: DiagnosticInput = { configured: true, scopes: ALL, accounts: [], appUrl: "http://localhost:3000", mediaBaseUrl: null };
const byId = (checks: ReturnType<typeof buildMetaDiagnostics>, id: string) => checks.find((c) => c.id === id)!;

describe("publicImageCheck", () => {
  it("con la app en localhost, Instagram no puede descargar las imagenes", () => {
    const r = publicImageCheck("http://localhost:3000", null);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/APP_URL.*local/);
  });

  it("un dominio con HTTPS esta bien, venga de APP_URL o de MEDIA_PUBLIC_BASE_URL", () => {
    expect(publicImageCheck("https://app.reservi.co", null)).toMatchObject({ ok: true });
    expect(publicImageCheck("http://localhost:3000", "https://abc-def-ghi.trycloudflare.com")).toMatchObject({ ok: true });
  });

  it("MEDIA_PUBLIC_BASE_URL manda sobre APP_URL", () => {
    expect(publicImageCheck("https://app.reservi.co", "http://localhost:3000").ok).toBe(false);
  });

  it("sin HTTPS no sirve", () => {
    const r = publicImageCheck("http://app.reservi.co", null);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/HTTPS/);
  });

  it("detecta el texto de ejemplo del manual copiado tal cual (el error real de Reservi)", () => {
    const r = publicImageCheck("http://localhost:3000", "https://palabras-al-azar.trycloudflare.com");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/parece el ejemplo/);
  });

  it("una direccion invalida se explica", () => {
    expect(publicImageCheck("http://localhost:3000", "no-es-una-url")).toMatchObject({ ok: false, detail: expect.stringMatching(/no es una dirección válida/) });
  });
});

describe("buildMetaDiagnostics", () => {
  it("sin la app de Meta configurada, lo primero que falta es eso", () => {
    const c = buildMetaDiagnostics({ ...base, configured: false });
    expect(byId(c, "app")).toMatchObject({ status: "todo", anchor: "crear-app" });
  });

  it("detecta que META_SCOPES no incluye los permisos de publicar (el caso real de antes)", () => {
    const c = buildMetaDiagnostics({ ...base, scopes: ["ads_read", "business_management", "pages_show_list", "pages_read_engagement"] });
    const scopes = byId(c, "scopes");
    expect(scopes.status).toBe("warn");
    expect(scopes.detail).toContain("pages_manage_posts");
    expect(scopes.detail).toContain("instagram_basic");
    expect(scopes.detail).toContain("instagram_content_publish");
  });

  it("si faltan solo los de Instagram, solo esos se nombran", () => {
    const c = buildMetaDiagnostics({ ...base, scopes: ALL.filter((s) => !s.startsWith("instagram")) });
    expect(byId(c, "scopes").detail).toContain("instagram_basic, instagram_content_publish");
    expect(byId(c, "scopes").detail).not.toContain("pages_manage_posts");
  });

  it("con todos los permisos pedidos queda en orden", () => {
    expect(byId(buildMetaDiagnostics(base), "scopes").status).toBe("ok");
  });

  it("sin cuentas conectadas aun, pide conectar y no habla de permisos de publicar", () => {
    const c = buildMetaDiagnostics(base);
    expect(byId(c, "pages")).toMatchObject({ status: "todo", anchor: "conectar" });
    expect(c.some((x) => x.id === "publish")).toBe(false);
  });

  it("paginas conectadas sin el permiso de publicar: avisa cuales (la conexion real de hoy)", () => {
    const c = buildMetaDiagnostics({
      ...base,
      accounts: [
        { kind: "FACEBOOK_PAGE", name: "Reservi", scopes: TODAY_SCOPES },
        { kind: "FACEBOOK_PAGE", name: "Smartec", scopes: TODAY_SCOPES },
        { kind: "AD_ACCOUNT", name: "Cuenta publicitaria", scopes: TODAY_SCOPES },
      ],
    });
    expect(byId(c, "pages")).toMatchObject({ status: "ok", title: expect.stringContaining("2 página") });
    const publish = byId(c, "publish");
    expect(publish.status).toBe("warn");
    expect(publish.detail).toContain("Reservi, Smartec");
    expect(publish.detail).not.toContain("Cuenta publicitaria"); // las cuentas publicitarias no publican
    expect(publish.anchor).toBe("permisos");
  });

  it("con el permiso concedido todo bien; si no se conocen los permisos, no se alarma", () => {
    const ok = buildMetaDiagnostics({ ...base, accounts: [{ kind: "FACEBOOK_PAGE", name: "Reservi", scopes: `${TODAY_SCOPES},pages_manage_posts` }] });
    expect(byId(ok, "publish").status).toBe("ok");
    const unknown = buildMetaDiagnostics({ ...base, accounts: [{ kind: "FACEBOOK_PAGE", name: "Reservi", scopes: null }] });
    expect(byId(unknown, "publish").status).toBe("ok");
  });

  it("sin Instagram conectado, explica la causa segun lo que falte", () => {
    const withoutScopes = buildMetaDiagnostics({ ...base, scopes: ALL.filter((s) => !s.startsWith("instagram")), accounts: [{ kind: "FACEBOOK_PAGE", name: "Reservi", scopes: null }] });
    expect(byId(withoutScopes, "instagram").detail).toMatch(/Falta pedir instagram_basic e instagram_content_publish/);
    const withScopes = buildMetaDiagnostics({ ...base, accounts: [{ kind: "FACEBOOK_PAGE", name: "Reservi", scopes: null }] });
    expect(byId(withScopes, "instagram").detail).toMatch(/profesional.*vinculada/);
    expect(byId(withScopes, "instagram").anchor).toBe("instagram");
  });

  it("con Instagram conectado lo cuenta; y el aviso de imagenes depende de la direccion publica", () => {
    const c = buildMetaDiagnostics({ ...base, appUrl: "https://app.reservi.co", accounts: [{ kind: "INSTAGRAM_PROFILE", name: "Reservi Oficial", scopes: null }] });
    expect(byId(c, "instagram")).toMatchObject({ status: "ok", detail: "Reservi Oficial" });
    expect(byId(c, "imagenes").status).toBe("ok");
    const local = buildMetaDiagnostics(base);
    expect(byId(local, "imagenes")).toMatchObject({ status: "warn", anchor: "publicar-instagram" });
    expect(byId(local, "imagenes").detail).toMatch(/Facebook sí publica/);
  });

  it("estadisticas: avisa si META_SCOPES no pide los permisos para leerlas y nombra cuales faltan", () => {
    const c = buildMetaDiagnostics({ ...base, scopes: ALL.filter((s) => s !== "read_insights" && s !== "instagram_manage_insights") });
    const stats = byId(c, "estadisticas");
    expect(stats.status).toBe("warn");
    expect(stats.detail).toContain("read_insights, instagram_manage_insights");
    expect(stats.detail).not.toContain("pages_read_engagement");
    expect(stats.anchor).toBe("estadisticas");
  });

  it("estadisticas: con todo pedido y sin cuentas aun, queda en orden", () => {
    expect(byId(buildMetaDiagnostics(base), "estadisticas")).toMatchObject({ status: "ok", detail: expect.stringContaining("META_SCOPES") });
  });

  it("estadisticas: cuentas conectadas sin read_insights (la conexion real de hoy) salen nombradas", () => {
    const c = buildMetaDiagnostics({
      ...base,
      accounts: [
        { kind: "FACEBOOK_PAGE", name: "Reservi", scopes: TODAY_SCOPES },
        { kind: "FACEBOOK_PAGE", name: "Smartec", scopes: `${TODAY_SCOPES},read_insights,pages_read_user_content` },
        { kind: "AD_ACCOUNT", name: "Cuenta publicitaria", scopes: TODAY_SCOPES },
      ],
    });
    const stats = byId(c, "estadisticas");
    expect(stats.status).toBe("warn");
    expect(stats.title).toContain("1 cuenta");
    expect(stats.detail).toContain("Reservi");
    expect(stats.detail).not.toContain("Smartec");
    expect(stats.detail).not.toContain("Cuenta publicitaria");
  });

  it("estadisticas: una pagina con read_insights pero sin pages_read_user_content (el caso real) tambien se avisa", () => {
    const realToday = "pages_show_list,pages_read_engagement,read_insights,pages_manage_posts";
    const c = buildMetaDiagnostics({ ...base, accounts: [{ kind: "FACEBOOK_PAGE", name: "Reservi", scopes: realToday }] });
    expect(byId(c, "estadisticas")).toMatchObject({ status: "warn", detail: expect.stringContaining("Reservi") });
    const notRequested = buildMetaDiagnostics({ ...base, scopes: ALL.filter((s) => s !== "pages_read_user_content") });
    expect(byId(notRequested, "estadisticas").detail).toContain("pages_read_user_content");
  });

  it("estadisticas: con los permisos concedidos o sin conocerlos, no alarma", () => {
    const granted = "pages_read_engagement,pages_read_user_content,read_insights,instagram_basic,instagram_manage_insights";
    const ok = buildMetaDiagnostics({ ...base, accounts: [{ kind: "FACEBOOK_PAGE", name: "Reservi", scopes: granted }, { kind: "INSTAGRAM_PROFILE", name: "Oficial", scopes: granted }] });
    expect(byId(ok, "estadisticas")).toMatchObject({ status: "ok", detail: expect.stringContaining("cuentas conectadas") });
    const unknown = buildMetaDiagnostics({ ...base, accounts: [{ kind: "FACEBOOK_PAGE", name: "Reservi", scopes: null }] });
    expect(byId(unknown, "estadisticas").status).toBe("ok");
  });

  it("anuncios: avisa si META_SCOPES no pide ads_management (con ads_read solo se ven cifras)", () => {
    const c = buildMetaDiagnostics({ ...base, scopes: ALL.filter((s) => s !== "ads_management") });
    expect(byId(c, "anuncios")).toMatchObject({ status: "warn", anchor: "anuncios", detail: expect.stringContaining("ads_management") });
  });

  it("anuncios: una cuenta publicitaria conectada sin el permiso se nombra", () => {
    const c = buildMetaDiagnostics({
      ...base,
      accounts: [
        { kind: "AD_ACCOUNT", name: "Reservi Ads", scopes: "ads_read,pages_show_list", dailyBudgetCap: 50000 },
        { kind: "AD_ACCOUNT", name: "Otra", scopes: "ads_read,ads_management", dailyBudgetCap: 50000 },
      ],
    });
    const ads = byId(c, "anuncios");
    expect(ads.status).toBe("warn");
    expect(ads.title).toContain("1 cuenta");
    expect(ads.detail).toContain("Reservi Ads");
    expect(ads.detail).not.toContain("Otra");
  });

  it("anuncios: con el permiso pero sin tope, queda pendiente y manda a fijarlo (sin tope no se crea nada)", () => {
    const c = buildMetaDiagnostics({ ...base, accounts: [{ kind: "AD_ACCOUNT", name: "Reservi Ads", scopes: "ads_management", dailyBudgetCap: null }, { kind: "AD_ACCOUNT", name: "Sin dato", scopes: "ads_management" }] });
    const ads = byId(c, "anuncios");
    expect(ads.status).toBe("todo");
    expect(ads.title).toContain("2 cuenta(s) publicitaria(s) sin tope");
    expect(ads.detail).toMatch(/sin él no se pueden crear ni activar/);
    expect(ads.anchor).toBe("anuncios");
  });

  it("anuncios: con permiso y tope en todas las cuentas, o sin cuentas aun, queda en orden", () => {
    const ok = buildMetaDiagnostics({ ...base, accounts: [{ kind: "AD_ACCOUNT", name: "Reservi Ads", scopes: "ads_management", dailyBudgetCap: 50000 }] });
    expect(byId(ok, "anuncios")).toMatchObject({ status: "ok", detail: expect.stringContaining("tope") });
    expect(byId(buildMetaDiagnostics(base), "anuncios").status).toBe("ok");
  });

  it("anuncios: con decenas de cuentas la lista se recorta («y N más») en lugar de ocupar toda la pantalla", () => {
    const many = Array.from({ length: 24 }, (_, i) => ({ kind: "AD_ACCOUNT", name: `Cuenta extra ${i}`, scopes: "ads_management", dailyBudgetCap: null }));
    const ads = byId(buildMetaDiagnostics({ ...base, accounts: many }), "anuncios");
    expect(ads.title).toContain("24 cuenta(s)");
    expect(ads.detail).toContain("Cuenta extra 0, Cuenta extra 1, Cuenta extra 2, Cuenta extra 3, Cuenta extra 4 y 19 más");
    expect(ads.detail).not.toContain("Cuenta extra 5");
  });

  it("nameList: hasta el maximo los nombra todos", () => {
    expect(nameList(["A", "B"])).toBe("A, B");
    expect(nameList(["A", "B", "C"], 2)).toBe("A, B y 1 más");
    expect(nameList([])).toBe("");
  });

  it("anuncios: las paginas y cuentas de Instagram no cuentan como cuentas publicitarias", () => {
    const c = buildMetaDiagnostics({ ...base, accounts: [{ kind: "FACEBOOK_PAGE", name: "Reservi", scopes: "pages_show_list" }] });
    expect(byId(c, "anuncios").status).toBe("ok");
  });

  it("cada comprobacion que no esta bien dice a que parte del manual ir", () => {
    const c = buildMetaDiagnostics({ ...base, configured: false, scopes: [] });
    for (const check of c.filter((x) => x.status !== "ok")) expect(check.anchor, check.id).toBeTruthy();
  });
});
