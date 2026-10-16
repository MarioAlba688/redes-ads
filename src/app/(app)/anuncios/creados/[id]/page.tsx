import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { dateTimeFormat } from "@/lib/display-time";
import { formatMoney } from "@/lib/format";
import { mediaPath } from "@/lib/media";
import { can } from "@/lib/permissions";
import { describeTargeting } from "@/lib/promotions/targeting";
import {
  KIND_LABELS,
  OBJECTIVE_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  effectiveStatusLabel,
  effectiveStatusTone,
  type CreativeInput,
  type PromotionKindName,
  type PromotionObjectiveName,
  type PromotionStatusName,
  type Targeting,
} from "@/lib/promotions/types";
import { maxTotalSpend } from "@/lib/promotions/validate";
import { PromotionActions } from "./promotion-actions";

export const metadata: Metadata = { title: "Anuncio" };

/** Instante actual; a nivel de modulo porque el lint no deja llamar a Date.now() dentro de un componente. */
const nowMs = () => Date.now();

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-5 py-3 text-sm sm:grid-cols-[12rem_1fr]">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default async function PromotionPage({ params, searchParams }: PageProps<"/anuncios/creados/[id]">) {
  const user = await requireUser("metrics.view");
  const { id } = await params;
  const q = await searchParams;

  const p = await db.adPromotion.findUnique({
    where: { id },
    include: {
      adAccount: { select: { name: true, currency: true, dailyBudgetCap: true } },
      brand: { select: { name: true } },
      createdBy: { select: { name: true } },
      activatedBy: { select: { name: true } },
      post: { select: { id: true, text: true } },
      target: { select: { externalUrl: true, account: { select: { name: true, kind: true } } } },
    },
  });
  if (!p) notFound();

  const status = p.status as PromotionStatusName;
  const kind = p.kind as PromotionKindName;
  const dateFmt = dateTimeFormat();
  const budget = Number(p.dailyBudget);
  const cap = p.adAccount.dailyBudgetCap === null ? null : Number(p.adAccount.dailyBudgetCap);
  const targeting = p.targeting as unknown as Targeting;
  const creative = p.creative as unknown as CreativeInput;
  const total = maxTotalSpend(budget, p.durationDays, p.currency);
  const canCreate = can(user.role, "ads.create");
  const canApprove = can(user.role, "ads.approve");
  const ended = status === "ACTIVE" && p.endsAt !== null && p.endsAt.getTime() < nowMs();

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/anuncios/creados" className="text-muted hover:text-foreground">
          ← Anuncios creados
        </Link>
      </p>
      <PageHeader
        title={p.name}
        description={`${KIND_LABELS[kind]}${p.brand ? ` · ${p.brand.name}` : ""}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</Badge>
            {p.effectiveStatus && status !== "FAILED" && <Badge tone={effectiveStatusTone(p.effectiveStatus)}>Meta: {effectiveStatusLabel(p.effectiveStatus)}</Badge>}
            {ended && <Badge>Terminó</Badge>}
          </div>
        }
      />

      {q.creado && status === "PAUSED" && (
        <div className="mb-4">
          <Alert tone="success">Anuncio creado en Meta, <strong>en pausa</strong>. No gasta nada hasta que una persona con permiso de aprobar lo active.</Alert>
        </div>
      )}
      {status === "FAILED" && p.error && (
        <div className="mb-4">
          <Alert>{p.error}</Alert>
        </div>
      )}

      <Card className="divide-y divide-border">
        <dl className="divide-y divide-border">
          <Row label="Cuenta publicitaria">{p.adAccount.name}</Row>
          <Row label="Objetivo">{OBJECTIVE_LABELS[p.objective as PromotionObjectiveName]}</Row>
          <Row label="Presupuesto por día">
            <strong>{formatMoney(budget, p.currency)}</strong>
            {cap !== null && <span className="text-muted"> · tope de la cuenta {formatMoney(cap, p.currency)}</span>}
          </Row>
          <Row label="Duración">
            {p.durationDays} {p.durationDays === 1 ? "día" : "días"}
            {total !== null && <span className="text-muted"> · gasto máximo posible {formatMoney(total, p.currency)}</span>}
          </Row>
          <Row label="A quién">{describeTargeting(targeting)}</Row>
          {p.activatedAt && <Row label="Activado">{dateFmt.format(p.activatedAt)}{p.activatedBy ? ` por ${p.activatedBy.name}` : ""}</Row>}
          {p.endsAt && <Row label="Termina">{dateFmt.format(p.endsAt)}</Row>}
          <Row label="Creado">{dateFmt.format(p.createdAt)}{p.createdBy ? ` por ${p.createdBy.name}` : ""}</Row>
          {p.lastSyncedAt && <Row label="Estado leído de Meta">{dateFmt.format(p.lastSyncedAt)}</Row>}
        </dl>
      </Card>

      <Card className="mt-6 space-y-3 p-5">
        <h2 className="font-semibold">Contenido</h2>
        {kind === "BOOST" && p.target && (
          <p className="text-sm text-muted">
            Publicación de {p.target.account.kind === "INSTAGRAM_PROFILE" ? "Instagram" : "Facebook"} <strong className="text-foreground">{p.target.account.name}</strong>
            {p.target.externalUrl && (
              <>
                {" · "}
                <a href={p.target.externalUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  Verla en la red social
                </a>
              </>
            )}
          </p>
        )}
        <p className="whitespace-pre-wrap text-sm">{creative.message || p.post?.text}</p>
        {creative.imageKey && (
          // Imagen dinamica servida por nuestra ruta /media: next/image no aporta nada aqui.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaPath(creative.imageKey)} alt="Imagen del anuncio" className="max-h-60 max-w-full rounded-lg border border-border" />
        )}
        {kind === "AD" && (
          <p className="text-sm text-muted">
            {creative.headline && <>Titular: <span className="text-foreground">{creative.headline}</span> · </>}
            {creative.link && <>Enlace: <span className="text-foreground">{creative.link}</span></>}
          </p>
        )}
        {p.post && (
          <p className="text-sm">
            <Link href={`/publicaciones/${p.post.id}`} className="text-primary hover:underline">
              Ver la publicación
            </Link>
          </p>
        )}
      </Card>

      {(canCreate || canApprove) && status !== "FAILED" && (
        <Card className="mt-6 p-5">
          <h2 className="mb-3 font-semibold">Acciones</h2>
          <PromotionActions id={p.id} status={status} canCreate={canCreate} canApprove={canApprove} budget={budget} currency={p.currency} cap={cap} days={p.durationDays} />
        </Card>
      )}

      {canApprove && (p.metaCampaignId || p.metaAdSetId || p.metaAdId) && (
        <p className="mt-6 text-xs text-muted">
          En Meta — campaña {p.metaCampaignId ?? "—"} · conjunto {p.metaAdSetId ?? "—"} · anuncio {p.metaAdId ?? "—"}
        </p>
      )}
    </>
  );
}
