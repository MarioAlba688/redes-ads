import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, PageHeader, buttonClass } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Marcas" };

export default async function BrandsPage() {
  const user = await requireUser("brands.view");
  const canManage = can(user.role, "brands.manage");
  const canWrite = can(user.role, "content.create");

  const [brands, unassigned] = await Promise.all([
    db.brand.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        description: true,
        _count: { select: { accounts: true, posts: true } },
      },
    }),
    db.socialAccount.count({ where: { brandId: null, status: { not: "REVOKED" }, kind: { in: ["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"] } } }),
  ]);

  return (
    <>
      <PageHeader
        title="Marcas"
        description="Cada negocio tiene su propia voz. La IA escribe con el perfil de la marca que elijas."
        action={
          canManage ? (
            <Link href="/marcas/nueva" className={buttonClass("primary")}>
              Nueva marca
            </Link>
          ) : undefined
        }
      />

      {unassigned > 0 && (
        <p className="mb-4 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          Hay {unassigned} página(s) o cuenta(s) de Instagram sin marca. Asígnalas a una marca para poder publicar en ellas.
        </p>
      )}

      {brands.length === 0 ? (
        <Card className="mx-auto mt-6 max-w-lg p-8 text-center">
          <h2 className="text-lg font-semibold">Aún no hay marcas</h2>
          <p className="mt-2 text-sm text-muted">
            Crea una por cada negocio (por ejemplo Smartec o Reservi), cuéntale a la IA cómo habla y asígnale sus páginas de
            Facebook e Instagram.
          </p>
          {canManage && (
            <Link href="/marcas/nueva" className={`${buttonClass("primary")} mt-5`}>
              Crear la primera marca
            </Link>
          )}
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {brands.map((b) => (
            <Card key={b.id} className="flex flex-col gap-3 p-5">
              <div>
                <h2 className="font-semibold">{b.name}</h2>
                <p className="mt-1 line-clamp-3 text-sm text-muted">{b.description}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge tone={b._count.accounts > 0 ? "success" : "warning"}>
                  {b._count.accounts} cuenta{b._count.accounts === 1 ? "" : "s"}
                </Badge>
                <Badge>
                  {b._count.posts} publicación{b._count.posts === 1 ? "" : "es"}
                </Badge>
              </div>
              <div className="mt-auto flex flex-wrap gap-2">
                <Link href={`/marcas/${b.id}`} className={buttonClass("secondary", true)}>
                  {canManage ? "Editar perfil" : "Ver perfil"}
                </Link>
                {canWrite && (
                  <Link href={`/publicaciones/nueva?marca=${b.id}`} className={buttonClass("primary", true)}>
                    Crear publicación
                  </Link>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
