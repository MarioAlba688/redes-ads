import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, PageHeader, buttonClass } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { dateTimeFormat } from "@/lib/display-time";
import { formatMoney } from "@/lib/format";
import { can } from "@/lib/permissions";
import {
  KIND_LABELS,
  OBJECTIVE_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  effectiveStatusLabel,
  effectiveStatusTone,
  type PromotionKindName,
  type PromotionObjectiveName,
  type PromotionStatusName,
} from "@/lib/promotions/types";

export const metadata: Metadata = { title: "Anuncios creados" };

const LIMIT = 100;

export default async function CreatedPromotionsPage() {
  const user = await requireUser("metrics.view");
  const canCreate = can(user.role, "ads.create");
  const canApprove = can(user.role, "ads.approve");
  const dateFmt = dateTimeFormat();

  const rows = await db.adPromotion.findMany({
    orderBy: { createdAt: "desc" },
    take: LIMIT,
    select: {
      id: true,
      name: true,
      kind: true,
      objective: true,
      status: true,
      effectiveStatus: true,
      dailyBudget: true,
      currency: true,
      durationDays: true,
      createdAt: true,
      adAccount: { select: { name: true } },
      brand: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
  });
  const waiting = rows.filter((r) => r.status === "PAUSED").length;

  return (
    <>
      <PageHeader
        title="Anuncios creados"
        description="Los anuncios de Facebook e Instagram que se crean desde esta app. Nacen en pausa y los activa quien aprueba."
        action={
          canCreate ? (
            <div className="flex flex-wrap gap-2">
              <Link href="/anuncios/nuevo?tipo=impulsar" className={buttonClass("primary")}>
                Impulsar una publicación
              </Link>
              <Link href="/anuncios/nuevo?tipo=anuncio" className={buttonClass("secondary")}>
                Anuncio nuevo
              </Link>
            </div>
          ) : undefined
        }
      />

      {canApprove && waiting > 0 && (
        <p className="mb-4 rounded-lg bg-warning-bg px-3 py-2 text-sm text-warning">
          {waiting === 1 ? "Hay 1 anuncio en pausa esperando que lo actives." : `Hay ${waiting} anuncios en pausa esperando que los actives.`}
        </p>
      )}

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="font-medium">Todavía no has creado anuncios desde la app</p>
            <p className="mt-1 text-sm text-muted">
              {canCreate ? "Impulsa una publicación que ya salió, o arma un anuncio nuevo con su texto y su imagen." : "Aquí aparecerán los que cree el equipo."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Anuncio</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Estado</th>
                  <th scope="col" className="px-5 py-2.5 text-right font-medium">Por día</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Creado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-5 py-3">
                      <Link href={`/anuncios/creados/${r.id}`} className="font-medium hover:underline">
                        {r.name}
                      </Link>
                      <p className="text-xs text-muted">
                        {KIND_LABELS[r.kind as PromotionKindName]} · {OBJECTIVE_LABELS[r.objective as PromotionObjectiveName]}
                        {r.brand ? ` · ${r.brand.name}` : ""} · {r.adAccount.name}
                      </p>
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={STATUS_TONES[r.status as PromotionStatusName]}>{STATUS_LABELS[r.status as PromotionStatusName]}</Badge>
                      {r.status === "FAILED" && canCreate && (
                        <p className="mt-1">
                          <Link href={`/anuncios/nuevo?copiar=${r.id}`} className="text-xs font-medium text-primary hover:underline">
                            Crear de nuevo
                          </Link>
                        </p>
                      )}
                      {r.effectiveStatus && r.status !== "FAILED" && r.status !== "ARCHIVED" && (
                        <p className="mt-1">
                          <Badge tone={effectiveStatusTone(r.effectiveStatus)}>Meta: {effectiveStatusLabel(r.effectiveStatus)}</Badge>
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums">
                      {formatMoney(Number(r.dailyBudget), r.currency)}
                      <p className="text-xs text-muted">{r.durationDays} {r.durationDays === 1 ? "día" : "días"}</p>
                    </td>
                    <td className="px-5 py-3 text-muted">
                      {dateFmt.format(r.createdAt)}
                      {r.createdBy && <p className="text-xs">{r.createdBy.name}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {rows.length === LIMIT && <p className="mt-3 text-xs text-muted">Se muestran los {LIMIT} más recientes.</p>}
    </>
  );
}
