import { describe, expect, it } from "vitest";
import { missingPublishScope, missingScopeMessage, missingStatsMessage, missingStatsScopes, PUBLISH_SCOPE, STATS_SCOPE } from "@/lib/meta/scopes";

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

describe("missingStatsScopes", () => {
  it("cada tipo de cuenta necesita un permiso basico y uno de insights", () => {
    expect(STATS_SCOPE).toEqual({
      FACEBOOK_PAGE: { basic: "pages_read_engagement", insights: "read_insights" },
      INSTAGRAM_PROFILE: { basic: "instagram_basic", insights: "instagram_manage_insights" },
    });
  });

  it("en la conexion real de hoy de Reservi falta read_insights, pero pages_read_engagement ya esta", () => {
    expect(missingStatsScopes("FACEBOOK_PAGE", GRANTED_TODAY)).toEqual({ basic: null, insights: "read_insights" });
    expect(missingStatsScopes("INSTAGRAM_PROFILE", GRANTED_TODAY)).toEqual({ basic: "instagram_basic", insights: "instagram_manage_insights" });
  });

  it("con todo concedido no falta nada, y no confunde un permiso con otro parecido", () => {
    expect(missingStatsScopes("FACEBOOK_PAGE", "pages_read_engagement, read_insights")).toEqual({ basic: null, insights: null });
    expect(missingStatsScopes("INSTAGRAM_PROFILE", "instagram_basic,instagram_manage_insights")).toEqual({ basic: null, insights: null });
    expect(missingStatsScopes("FACEBOOK_PAGE", "pages_read_engagement_extra,my_read_insights")).toEqual({ basic: "pages_read_engagement", insights: "read_insights" });
  });

  it("si no se conocen los permisos, o la cuenta no es de publicacion, no bloquea nada", () => {
    for (const scopes of [null, undefined, "  "]) expect(missingStatsScopes("FACEBOOK_PAGE", scopes)).toEqual({ basic: null, insights: null });
    expect(missingStatsScopes("AD_ACCOUNT", GRANTED_TODAY)).toEqual({ basic: null, insights: null });
  });

  it("el mensaje dice que falta, que no se lee y como arreglarlo", () => {
    const insights = missingStatsMessage("Reservi", "read_insights", "insights");
    expect(insights).toContain("«Reservi»");
    expect(insights).toContain("read_insights");
    expect(insights).toMatch(/vistas, el alcance/);
    expect(insights).toMatch(/META_SCOPES/);
    expect(insights).toMatch(/Reconectar Meta/);
    expect(missingStatsMessage("Reservi", "pages_read_engagement", "basic")).toMatch(/ninguna cifra/);
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
