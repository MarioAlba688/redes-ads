import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Card, PageHeader, buttonClass } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { LANGUAGES } from "@/lib/ai/limits";
import { can } from "@/lib/permissions";
import { loadAccountOptions } from "../account-options";
import { BrandForm, DeleteBrandForm } from "../brand-form";

export const metadata: Metadata = { title: "Marca" };

export default async function BrandPage({ params, searchParams }: PageProps<"/marcas/[id]">) {
  const user = await requireUser("brands.view");
  const { id } = await params;
  const q = await searchParams;

  const brand = await db.brand.findUnique({
    where: { id },
    include: { accounts: { select: { id: true } }, _count: { select: { posts: true } } },
  });
  if (!brand) notFound();

  const canManage = can(user.role, "brands.manage");
  const canWrite = can(user.role, "content.create");
  const accounts = await loadAccountOptions();
  const owned = accounts.filter((a) => a.brandId === brand.id);

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/marcas" className="text-muted hover:text-foreground">
          ← Marcas
        </Link>
      </p>
      <PageHeader
        title={brand.name}
        description={`${LANGUAGES[brand.language as keyof typeof LANGUAGES] ?? brand.language} · ${brand.timezone.replace(/_/g, " ")}`}
        action={
          canWrite ? (
            <Link href={`/publicaciones/nueva?marca=${brand.id}`} className={buttonClass("primary")}>
              Crear publicación
            </Link>
          ) : undefined
        }
      />
      {q.creada && (
        <div className="mb-4">
          <Alert tone="success">Marca creada. Ya puedes crear publicaciones con su voz.</Alert>
        </div>
      )}

      {canManage ? (
        <>
          <BrandForm
            brand={{
              id: brand.id,
              name: brand.name,
              description: brand.description,
              audience: brand.audience,
              tone: brand.tone,
              products: brand.products,
              avoid: brand.avoid,
              hashtags: brand.hashtags,
              callToAction: brand.callToAction,
              language: brand.language,
              timezone: brand.timezone,
            }}
            accounts={accounts}
            selectedIds={brand.accounts.map((a) => a.id)}
          />
          <Card className="mt-8 p-5">
            <h2 className="font-semibold">Eliminar marca</h2>
            <p className="mb-3 text-sm text-muted">
              {brand._count.posts > 0
                ? `Tiene ${brand._count.posts} publicación(es): no se puede eliminar mientras existan.`
                : "Se borra el perfil y sus cuentas quedan sin marca."}
            </p>
            <DeleteBrandForm brandId={brand.id} />
          </Card>
        </>
      ) : (
        <Card className="space-y-4 p-5 text-sm">
          {(
            [
              ["Qué hace el negocio", brand.description],
              ["Público", brand.audience],
              ["Tono y voz", brand.tone],
              ["Productos y ofertas", brand.products],
              ["Palabras a evitar", brand.avoid],
              ["Hashtags", brand.hashtags],
              ["Llamado a la acción", brand.callToAction],
            ] as const
          )
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <p className="text-muted">{label}</p>
                <p className="mt-0.5 whitespace-pre-wrap">{value}</p>
              </div>
            ))}
          <div>
            <p className="text-muted">Cuentas</p>
            <p className="mt-0.5">{owned.map((a) => a.name).join(", ") || "Ninguna"}</p>
          </div>
        </Card>
      )}
    </>
  );
}
