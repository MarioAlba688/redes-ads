import "server-only";
import { db } from "@/lib/db";
import { PUBLISHABLE_KINDS } from "@/lib/posts";
import type { AccountOption } from "./brand-form";

/** Cuentas que se pueden asignar a una marca: donde se publica (paginas e Instagram) y las cuentas publicitarias. */
export async function loadAccountOptions(): Promise<AccountOption[]> {
  const rows = await db.socialAccount.findMany({
    where: { platform: "META" },
    select: {
      id: true,
      name: true,
      kind: true,
      platform: true,
      handle: true,
      status: true,
      brandId: true,
      brand: { select: { name: true } },
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  // Las de publicacion primero; las cuentas publicitarias van despues.
  const publishFirst = (k: string) => ((PUBLISHABLE_KINDS as readonly string[]).includes(k) ? 0 : 1);
  return rows
    .sort((a, b) => publishFirst(a.kind) - publishFirst(b.kind))
    .map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      platform: a.platform,
      handle: a.handle,
      brandId: a.brandId,
      brandName: a.brand?.name ?? null,
      revoked: a.status === "REVOKED",
    }));
}
