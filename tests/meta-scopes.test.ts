import { describe, expect, it } from "vitest";
import { ADS_WRITE_SCOPE, missingAdsWriteMessage, missingAdsWriteScope, missingPublishScope, missingScopeMessage, missingStatsMessage, missingStatsScopes, PUBLISH_SCOPE, STATS_SCOPE } from "@/lib/meta/scopes";

// Los permisos que concedio de verdad la conexion real de Reservi: tenia anuncios y paginas, pero no publicar.
const GRANTED_TODAY = "pages_show_list,ads_read,business_management,pages_read_engagement,public_profile";

describe("missingPublishScope", () => {
  it("cada tipo de cuenta necesita su propio permiso", () => {
    expect(PUBLISH_SCOPE).toEqual({ FACEBOOK_PAGE: "pages_manage_posts", INSTAGRAM_PROFILE: "instagram_content_publish" });
  });

  it("detecta que falta pages_manage_posts en la conexion real de hoy", () => {
    expect(missingPublishScope("FACEBOOK_PAGE", GRANTED_TODAY)).toBe("pages_manage_posts");
    expect(missingPublishScope("INSTAGRAM_PROFILE", GRANTED_TODAY)).toBe("instagram_content_publish");
  });

  it("con el permiso concedido no falta nada (aunque haya espacios en la lista)", () => {
    expect(missingPublishScope("FACEBOOK_PAGE", `${GRANTED_TODAY},pages_manage_posts`)).toBeNull();
    expect(missingPublishScope("FACEBOOK_PAGE", "ads_read, pages_manage_posts ,x")).toBeNull();
    expect(missingPublishScope("INSTAGRAM_PROFILE", "instagram_basic,instagram_content_publish")).toBeNull();
  });

  it("no confunde un permiso con otro que lo contiene como texto", () => {
    expect(missingPublishScope("FACEBOOK_PAGE", "pages_manage_posts_extra,my_pages_manage_posts")).toBe("pages_manage_posts");
  });

  it("si no se conocen los permisos, o la cuenta no es de publicacion, no bloquea nada", () => {
    expect(missingPublishScope("FACEBOOK_PAGE", null)).toBeNull();
    expect(missingPublishScope("FACEBOOK_PAGE", undefined)).toBeNull();
    expect(missingPublishScope("FACEBOOK_PAGE", "  ")).toBeNull();
    expect(missingPublishScope("AD_ACCOUNT", GRANTED_TODAY)).toBeNull();
  });
});

describe("missingAdsWriteScope (crear anuncios)", () => {
  it("crear y administrar anuncios exige ads_management, que leerlos (ads_read) no da", () => {
    expect(ADS_WRITE_SCOPE).toBe("ads_management");
    expect(missingAdsWriteScope(GRANTED_TODAY)).toBe("ads_management");
    expect(GRANTED_TODAY).toContain("ads_read");
  });

  it("con el permiso no falta nada (aunque haya espacios); si no se conocen, decide Meta", () => {
    expect(missingAdsWriteScope("ads_read, ads_management ,x")).toBeNull();
    expect(missingAdsWriteScope("ads_management_extra")).toBe("ads_management");
    for (const s of [null, undefined, "  "]) expect(missingAdsWriteScope(s)).toBeNull();
  });

  it("el mensaje dice la cuenta, el permiso y los pasos", () => {
    const m = missingAdsWriteMessage("Reservi Ads");
    expect(m).toContain("«Reservi Ads»");
    expect(m).toContain("ads_management");
    expect(m).toMatch(/META_SCOPES/);
    expect(m).toMatch(/Reconectar Meta/);
  });
});

describe("missingStatsScopes", () => {
  const NONE = { basic: null, insights: null, content: null };

  it("cada tipo de cuenta necesita un permiso basico y uno de insights; Facebook, ademas, uno para comentarios y reacciones", () => {
    expect(STATS_SCOPE).toEqual({
      FACEBOOK_PAGE: { basic: "pages_read_engagement", insights: "read_insights", content: "pages_read_user_content" },
      INSTAGRAM_PROFILE: { basic: "instagram_basic", insights: "instagram_manage_insights", content: null },
    });
  });

  it("en la conexion real de hoy de Reservi falta read_insights y pages_read_user_content, pero pages_read_engagement ya esta", () => {
    expect(missingStatsScopes("FACEBOOK_PAGE", GRANTED_TODAY)).toEqual({ basic: null, insights: "read_insights", content: "pages_read_user_content" });
    expect(missingStatsScopes("INSTAGRAM_PROFILE", GRANTED_TODAY)).toEqual({ basic: "instagram_basic", insights: "instagram_manage_insights", content: null });
  });

  it("con todo concedido no falta nada, y no confunde un permiso con otro parecido", () => {
    expect(missingStatsScopes("FACEBOOK_PAGE", "pages_read_engagement, read_insights,pages_read_user_content")).toEqual(NONE);
    expect(missingStatsScopes("INSTAGRAM_PROFILE", "instagram_basic,instagram_manage_insights")).toEqual(NONE);
    expect(missingStatsScopes("FACEBOOK_PAGE", "pages_read_engagement_extra,my_read_insights,pages_read_user_content_x")).toEqual({
      basic: "pages_read_engagement",
      insights: "read_insights",
      content: "pages_read_user_content",
    });
  });

  it("Instagram nunca pide el permiso de contenido de Facebook", () => {
    expect(missingStatsScopes("INSTAGRAM_PROFILE", "instagram_basic,instagram_manage_insights").content).toBeNull();
  });

  it("si no se conocen los permisos, o la cuenta no es de publicacion, no bloquea nada", () => {
    for (const scopes of [null, undefined, "  "]) expect(missingStatsScopes("FACEBOOK_PAGE", scopes)).toEqual(NONE);
    expect(missingStatsScopes("AD_ACCOUNT", GRANTED_TODAY)).toEqual(NONE);
  });

  it("el mensaje dice que falta, que no se lee y como arreglarlo", () => {
    const insights = missingStatsMessage("Reservi", "read_insights", "insights");
    expect(insights).toContain("«Reservi»");
    expect(insights).toContain("read_insights");
    expect(insights).toMatch(/vistas, el alcance/);
    expect(insights).toMatch(/META_SCOPES/);
    expect(insights).toMatch(/Reconectar Meta/);
    expect(missingStatsMessage("Reservi", "pages_read_engagement", "basic")).toMatch(/ninguna cifra/);
    const content = missingStatsMessage("Reservi", "pages_read_user_content", "content");
    expect(content).toContain("pages_read_user_content");
    expect(content).toMatch(/comentarios/);
    expect(content).toMatch(/Reconectar Meta/);
  });
});

describe("missingScopeMessage", () => {
  it("dice que permiso falta y los pasos para arreglarlo", () => {
    const m = missingScopeMessage("Reservi", "pages_manage_posts");
    expect(m).toContain("«Reservi»");
    expect(m).toContain("pages_manage_posts");
    expect(m).toMatch(/app de Meta/);
    expect(m).toMatch(/META_SCOPES/);
    expect(m).toMatch(/Reconectar Meta/);
  });
});
