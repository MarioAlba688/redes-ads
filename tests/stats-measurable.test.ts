import { describe, expect, it } from "vitest";
import { FACEBOOK_REEL_NOTICE, isMeasurable, MEASURABLE_WHERE } from "@/lib/stats/measurable";

describe("isMeasurable: de que publicaciones se leen las estadisticas", () => {
  it("una foto o un carrusel se lee en cualquier red", () => {
    expect(isMeasurable({ accountKind: "FACEBOOK_PAGE", isVideo: false })).toBe(true);
    expect(isMeasurable({ accountKind: "INSTAGRAM_PROFILE", isVideo: false })).toBe(true);
  });

  it("un Reel de Instagram se lee: su id es el de un medio de Instagram, como el de una foto", () => {
    expect(isMeasurable({ accountKind: "INSTAGRAM_PROFILE", isVideo: true })).toBe(true);
  });

  it("un Reel de Facebook todavia no: tiene otro id (el del video) y otras metricas", () => {
    expect(isMeasurable({ accountKind: "FACEBOOK_PAGE", isVideo: true })).toBe(false);
  });

  it("el aviso dice que es de Facebook y que las cifras se miran alli", () => {
    expect(FACEBOOK_REEL_NOTICE).toMatch(/Reels de Facebook/);
    expect(FACEBOOK_REEL_NOTICE).toMatch(/estadísticas/);
  });
});

// El filtro de la base de datos no se puede correr aqui (no hay MySQL): se interpreta su forma, que es solo `OR`,
// `account.kind` y `post.media.none.kind`, y se comprueba que da lo mismo que isMeasurable en todas las combinaciones.
type Where = { OR?: Where[]; account?: { kind: string }; post?: { media: { none: { kind: string } } } };
type Facts = { accountKind: string; media: { kind: string }[] };

function matches(where: Where, facts: Facts): boolean {
  if (where.OR) return where.OR.some((w) => matches(w, facts));
  if (where.account) return where.account.kind === facts.accountKind;
  if (where.post) {
    const forbidden = where.post.media.none.kind;
    return !facts.media.some((m) => m.kind === forbidden);
  }
  throw new Error(`el filtro tiene una forma que esta prueba no entiende: ${JSON.stringify(where)}`);
}

describe("MEASURABLE_WHERE: el mismo criterio, para la base de datos", () => {
  const where = MEASURABLE_WHERE as unknown as Where;

  for (const accountKind of ["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"]) {
    for (const isVideo of [false, true]) {
      it(`${accountKind} ${isVideo ? "con video" : "sin video"}`, () => {
        const facts: Facts = { accountKind, media: isVideo ? [{ kind: "VIDEO" }] : [{ kind: "IMAGE" }, { kind: "IMAGE" }] };
        expect(matches(where, facts)).toBe(isMeasurable({ accountKind, isVideo }));
      });
    }
  }

  it("una publicacion sin ningun medio tambien se lee", () => {
    expect(matches(where, { accountKind: "FACEBOOK_PAGE", media: [] })).toBe(true);
  });
});
