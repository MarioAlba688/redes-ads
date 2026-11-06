import { describe, expect, it } from "vitest";
import { parseRange } from "@/lib/http-range";

describe("parseRange", () => {
  it("sin cabecera, con varios tramos o con un formato raro sirve el archivo entero", () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 1000)).toBeNull();
    expect(parseRange("items=0-1", 1000)).toBeNull();
    expect(parseRange("bytes=0-10", 0)).toBeNull();
  });

  it("un tramo normal, hasta el final y los ultimos N bytes", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
  });

  it("un final mas alla del archivo se recorta al ultimo byte", () => {
    expect(parseRange("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=999-2000", 1000)).toEqual({ start: 999, end: 999 });
  });

  it("un tramo que no cabe es invalido (416)", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("invalid");
    expect(parseRange("bytes=2000-3000", 1000)).toBe("invalid");
    expect(parseRange("bytes=5-2", 1000)).toBe("invalid");
    expect(parseRange("bytes=-0", 1000)).toBe("invalid");
    expect(parseRange("bytes=-", 1000)).toBe("invalid");
  });
});
