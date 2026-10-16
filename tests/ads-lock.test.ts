import { describe, expect, it } from "vitest";
import { withAccountLock } from "@/lib/ads/lock";

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
};

describe("withAccountLock", () => {
  it("una sincronizacion en curso de la misma cuenta impide empezar otra", async () => {
    const g = gate();
    const first = withAccountLock("cuenta-1", async () => {
      await g.promise;
      return "listo";
    });
    const second = await withAccountLock("cuenta-1", async () => "no deberia correr");
    expect(second).toEqual({ ran: false });
    g.open();
    expect(await first).toEqual({ ran: true, value: "listo" });
  });

  it("cuentas distintas no se bloquean entre si", async () => {
    const g = gate();
    const a = withAccountLock("cuenta-a", () => g.promise.then(() => "a"));
    const b = await withAccountLock("cuenta-b", async () => "b");
    expect(b).toEqual({ ran: true, value: "b" });
    g.open();
    expect((await a).ran).toBe(true);
  });

  it("al terminar (o fallar) se libera, y se puede volver a sincronizar", async () => {
    await expect(withAccountLock("cuenta-2", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withAccountLock("cuenta-2", async () => 1)).toEqual({ ran: true, value: 1 });
    expect(await withAccountLock("cuenta-2", async () => 2)).toEqual({ ran: true, value: 2 });
  });
});
