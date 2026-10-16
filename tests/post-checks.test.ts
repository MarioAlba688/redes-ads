import { describe, expect, it } from "vitest";
import { validatePostForReview, type ReviewCheckInput } from "@/lib/post-checks";

const fb = { name: "Reservi", kind: "FACEBOOK_PAGE", status: "ACTIVE", brandId: "b1" };
const ig = { name: "Reservi Oficial", kind: "INSTAGRAM_PROFILE", status: "ACTIVE", brandId: "b1" };
const jpg = { mimeType: "image/jpeg", width: 1080, height: 1080 };
const base: ReviewCheckInput = { text: "Hola", brandId: "b1", targets: [fb], media: [] };

describe("validatePostForReview", () => {
  it("una publicacion de texto para Facebook esta lista", () => {
    expect(validatePostForReview(base)).toEqual([]);
  });

  it("pide texto y al menos un destino", () => {
    expect(validatePostForReview({ ...base, text: "  ", targets: [] })).toEqual([
      "Escribe el texto de la publicación.",
      "Elige al menos un destino (una página de Facebook o una cuenta de Instagram).",
    ]);
  });

  it("Instagram exige imagen", () => {
    expect(validatePostForReview({ ...base, targets: [fb, ig] })).toEqual([expect.stringMatching(/Instagram necesita una imagen/)]);
    expect(validatePostForReview({ ...base, targets: [fb, ig], media: [jpg] })).toEqual([]);
  });

  it("Instagram rechaza PNG, imagenes pequeñas o de proporcion rara, y Facebook solo no las revisa", () => {
    expect(validatePostForReview({ ...base, targets: [ig], media: [{ ...jpg, mimeType: "image/png" }] })).toEqual([expect.stringMatching(/solo acepta imágenes JPG/)]);
    expect(validatePostForReview({ ...base, targets: [ig], media: [{ ...jpg, width: 100, height: 100 }] })).toEqual([expect.stringMatching(/muy pequeña/)]);
    expect(validatePostForReview({ ...base, targets: [ig], media: [{ ...jpg, width: 1000, height: 3000 }] })).toEqual([expect.stringMatching(/4:5/)]);
    expect(validatePostForReview({ ...base, targets: [fb], media: [{ mimeType: "image/png", width: 100, height: 100 }] })).toEqual([]);
  });

  it("varias imagenes: Instagram revisa cada una y dice cual falla; Facebook solo las cuenta", () => {
    const png = { ...jpg, mimeType: "image/png" };
    expect(validatePostForReview({ ...base, targets: [fb, ig], media: [jpg, jpg, jpg] })).toEqual([]);
    expect(validatePostForReview({ ...base, targets: [ig], media: [jpg, png] })).toEqual([expect.stringMatching(/^Imagen 2: .*solo acepta imágenes JPG/)]);
    expect(validatePostForReview({ ...base, targets: [ig], media: [{ ...jpg, width: 100, height: 100 }, jpg, { ...jpg, width: 1000, height: 3000 }] })).toEqual([
      expect.stringMatching(/^Imagen 1: .*muy pequeña/),
      expect.stringMatching(/^Imagen 3: .*4:5/),
    ]);
    // Con una sola imagen el mensaje no lleva «Imagen 1:».
    expect(validatePostForReview({ ...base, targets: [ig], media: [png] })[0]).toMatch(/^Instagram solo acepta/);
    expect(validatePostForReview({ ...base, targets: [fb], media: [png, png] })).toEqual([]);
  });

  it("mas de 10 imagenes no pasa, en cualquier destino", () => {
    const eleven = Array.from({ length: 11 }, () => jpg);
    expect(validatePostForReview({ ...base, targets: [fb], media: eleven })).toEqual([expect.stringMatching(/hasta 10 imágenes y esta tiene 11\. Quita una\./)]);
    expect(validatePostForReview({ ...base, targets: [fb], media: Array.from({ length: 10 }, () => jpg) })).toEqual([]);
    expect(validatePostForReview({ ...base, targets: [fb], media: Array.from({ length: 13 }, () => jpg) })).toEqual([expect.stringMatching(/Quita 3\./)]);
  });

  it("avisa de destinos desconectados, vencidos o de otra marca", () => {
    const errors = validatePostForReview({
      ...base,
      targets: [
        { ...fb, name: "A", status: "REVOKED" },
        { ...fb, name: "B", status: "EXPIRED" },
        { ...fb, name: "C", brandId: "otra" },
      ],
    });
    expect(errors).toEqual([
      expect.stringMatching(/«A» está desconectada/),
      expect.stringMatching(/conexión de «B» venció/),
      expect.stringMatching(/«C» ya no pertenece a esta marca/),
    ]);
  });

  it("avisa si la conexion con Meta no tiene el permiso de publicar, y dice cual", () => {
    const FB_SCOPES = "ads_read,business_management,pages_show_list,pages_read_engagement";
    const errors = validatePostForReview({ ...base, targets: [{ ...fb, scopes: FB_SCOPES }] });
    expect(errors).toEqual([expect.stringMatching(/«Reservi» no incluye el permiso pages_manage_posts.*Reconectar Meta/)]);
    // Instagram necesita otro permiso.
    const igErrors = validatePostForReview({ ...base, targets: [{ ...ig, scopes: `${FB_SCOPES},pages_manage_posts` }], media: [jpg] });
    expect(igErrors).toEqual([expect.stringMatching(/«Reservi Oficial» no incluye el permiso instagram_content_publish/)]);
  });

  it("con el permiso concedido, o sin saber que permisos hay, no bloquea", () => {
    expect(validatePostForReview({ ...base, targets: [{ ...fb, scopes: "ads_read,pages_manage_posts" }] })).toEqual([]);
    expect(validatePostForReview({ ...base, targets: [{ ...fb, scopes: null }] })).toEqual([]);
    expect(validatePostForReview({ ...base, targets: [{ ...fb, scopes: "" }] })).toEqual([]);
    expect(validatePostForReview({ ...base, targets: [{ ...fb }] })).toEqual([]);
  });

  it("una conexion vencida se avisa como vencida, sin repetir el aviso del permiso", () => {
    expect(validatePostForReview({ ...base, targets: [{ ...fb, status: "EXPIRED", scopes: "ads_read" }] })).toEqual([expect.stringMatching(/venció/)]);
  });

  it("aplica el limite de caracteres del destino mas estricto", () => {
    const long = "x".repeat(2300);
    expect(validatePostForReview({ ...base, text: long, targets: [fb] })).toEqual([]);
    expect(validatePostForReview({ ...base, text: long, targets: [fb, ig], media: [jpg] })).toEqual([expect.stringMatching(/límite es 2200/)]);
  });

  it("junta varios problemas a la vez para corregirlos de una vez", () => {
    expect(validatePostForReview({ text: "", brandId: "b1", targets: [ig], media: [] })).toHaveLength(2);
  });
});
