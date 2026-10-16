import type { Metadata } from "next";
import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { getAiUsage } from "@/lib/ai/service";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";
import { Composer } from "../composer";

export const metadata: Metadata = { title: "Nueva publicación" };

export default async function NewPostPage({ searchParams }: PageProps<"/publicaciones/nueva">) {
  const user = await requireUser("content.create");
  const q = await searchParams;
  const brandId = typeof q.marca === "string" ? q.marca : null;

  const brands = await db.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, description: true } });
  const brand = brandId ? await db.brand.findUnique({ where: { id: brandId }, select: { id: true, name: true } }) : null;

  const back = (
    <p className="mb-2 text-sm">
      <Link href="/publicaciones" className="text-muted hover:text-foreground">
        ← Publicaciones
      </Link>
    </p>
  );

  // Primero se elige la marca: de ella salen la voz de la IA y los destinos disponibles.
  if (!brand) {
    return (
      <>
        {back}
        <PageHeader title="Nueva publicación" description="¿Para qué marca es?" />
        {brands.length === 0 ? (
          <Card className="mx-auto mt-6 max-w-lg p-8 text-center">
            <h2 className="text-lg font-semibold">Primero crea una marca</h2>
            <p className="mt-2 text-sm text-muted">La IA escribe con el perfil de una marca y se publica en las cuentas que le asignes.</p>
            <Link href="/marcas/nueva" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
              Crear una marca
            </Link>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {brands.map((b) => (
              <Link key={b.id} href={`/publicaciones/nueva?marca=${b.id}`}>
                <Card className="h-full p-5 transition-colors hover:border-primary/40">
                  <h2 className="font-semibold">{b.name}</h2>
                  <p className="mt-1 line-clamp-2 text-sm text-muted">{b.description}</p>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </>
    );
  }

  const [accounts, ai] = await Promise.all([
    db.socialAccount.findMany({
      where: { brandId: brand.id, status: { not: "REVOKED" }, kind: { in: ["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"] } },
      select: { id: true, name: true, kind: true, handle: true },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    getAiUsage(user.id),
  ]);

  return (
    <>
      {back}
      <PageHeader title={`Nueva publicación · ${brand.name}`} />
      <Composer
        brand={brand}
        targets={accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind as "FACEBOOK_PAGE" | "INSTAGRAM_PROFILE", handle: a.handle }))}
        ai={{ ...ai, canManage: can(user.role, "ai.manage") }}
      />
    </>
  );
}
