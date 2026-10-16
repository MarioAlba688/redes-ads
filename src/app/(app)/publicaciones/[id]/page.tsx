import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Badge, Card, PageHeader } from "@/components/ui";
import { getAiUsage } from "@/lib/ai/service";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { dateTimeFormat } from "@/lib/display-time";
import { mediaPath } from "@/lib/media";
import { can } from "@/lib/permissions";
import { ACCOUNT_KIND_LABELS } from "@/lib/platforms";
import { availableActions } from "@/lib/post-workflow";
import {
  POST_STATUS_LABELS,
  POST_STATUS_TONES,
  TARGET_STATUS_LABELS,
  isEditable,
  type PostStatusName,
} from "@/lib/posts";
import { formatLocalInput } from "@/lib/time";
import { Composer, DeleteDraftForm } from "../composer";
import { PostActions } from "./post-actions";

export const metadata: Metadata = { title: "Publicación" };

const EVENT_LABELS: Record<string, string> = {
  "post.created": "creó el borrador",
  "post.updated": "editó el borrador",
  "post.media_added": "añadió una imagen",
  "post.media_removed": "quitó la imagen",
  "post.submitted": "la envió a revisión",
  "post.returned": "la devolvió con una nota",
  "post.approved": "la aprobó",
  "post.scheduled": "la programó",
  "post.publish_now": "pidió publicarla ahora",
  "post.retry": "pidió reintentar",
  "post.cancelled": "la canceló",
  "post.target_published": "Publicada en",
  "post.target_failed": "Falló en",
  "post.published": "Publicada en todos los destinos",
  "post.partial": "Publicada solo en parte",
  "post.failed": "No se pudo publicar",
};

/** Hora sugerida (dentro de ~1 h, redondeada a 5 min) y minima (dentro de 3 min) en la zona de la marca. */
function suggestedTimes(timezone: string) {
  const plus = (minutes: number) => new Date(Date.now() + minutes * 60_000);
  const rounded = new Date(Math.ceil(plus(60).getTime() / 300_000) * 300_000);
  return { defaultWhen: formatLocalInput(rounded, timezone), minWhen: formatLocalInput(plus(3), timezone) };
}

export default async function PostPage({ params, searchParams }: PageProps<"/publicaciones/[id]">) {
  const user = await requireUser("content.view");
  const { id } = await params;
  const q = await searchParams;

  const post = await db.post.findUnique({
    where: { id },
    include: {
      brand: { select: { id: true, name: true, timezone: true } },
      createdBy: { select: { name: true } },
      reviewedBy: { select: { name: true } },
      targets: { include: { account: { select: { id: true, name: true, kind: true, handle: true } } } },
      media: { orderBy: { position: "asc" } },
    },
  });
  if (!post) notFound();

  const status = post.status as PostStatusName;
  const canWrite = can(user.role, "content.create");
  const dateFmt = dateTimeFormat();
  const tz = post.brand.timezone;
  const whenFmt = new Intl.DateTimeFormat("es", { dateStyle: "full", timeStyle: "short", timeZone: tz });

  const header = (
    <>
      <p className="mb-2 text-sm">
        <Link href="/publicaciones" className="text-muted hover:text-foreground">
          ← Publicaciones
        </Link>
      </p>
      <PageHeader
        title={post.brand.name}
        description={`Creada ${dateFmt.format(post.createdAt)}${post.createdBy ? ` por ${post.createdBy.name}` : ""}`}
        action={<Badge tone={POST_STATUS_TONES[status]}>{POST_STATUS_LABELS[status]}</Badge>}
      />
      {q.guardada && (
        <div className="mb-4">
          <Alert tone="success">Borrador guardado.</Alert>
        </div>
      )}
      {status === "DRAFT" && post.reviewNote && (
        <div className="mb-4">
          <Alert tone="warning">
            <strong>Devuelta{post.reviewedBy ? ` por ${post.reviewedBy.name}` : ""}:</strong> {post.reviewNote}
          </Alert>
        </div>
      )}
    </>
  );

  const actions = availableActions(status, user.role);
  const suggested = suggestedTimes(tz);
  // Al reprogramar, el campo parte de la hora actual de la publicacion y no de "dentro de una hora".
  const times = {
    ...suggested,
    defaultWhen: post.scheduledAt && status === "SCHEDULED" ? formatLocalInput(post.scheduledAt, tz) : suggested.defaultWhen,
  };
  const events = await db.auditLog.findMany({
    where: { target: id, action: { startsWith: "post." } },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { id: true, action: true, createdAt: true, detail: true, user: { select: { name: true } } },
  });

  const history = (
    <Card className="mt-6">
      <div className="border-b border-border px-5 py-4">
        <h2 className="font-semibold">Historial</h2>
      </div>
      {events.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">Sin movimientos todavía.</p>
      ) : (
        <ul className="divide-y divide-border">
          {events.map((ev) => {
            const account = (ev.detail as { account?: string } | null)?.account;
            const system = ev.action.startsWith("post.target_") || ["post.published", "post.partial", "post.failed"].includes(ev.action);
            return (
              <li key={ev.id} className="flex flex-wrap items-baseline gap-x-2 px-5 py-2.5 text-sm">
                {!system && <span className="font-medium">{ev.user?.name ?? "Alguien"}</span>}
                <span className={system ? "font-medium" : "text-muted"}>
                  {EVENT_LABELS[ev.action] ?? ev.action}
                  {account ? ` ${account}` : ""}
                </span>
                <span className="ml-auto text-xs text-muted">{dateFmt.format(ev.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );

  // Un borrador se edita con el mismo editor que al crear.
  if (isEditable(status) && canWrite) {
    const [accounts, ai] = await Promise.all([
      db.socialAccount.findMany({
        where: { brandId: post.brand.id, status: { not: "REVOKED" }, kind: { in: ["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"] } },
        select: { id: true, name: true, kind: true, handle: true },
        orderBy: [{ kind: "asc" }, { name: "asc" }],
      }),
      getAiUsage(user.id),
    ]);
    return (
      <>
        {header}
        <Composer
          brand={post.brand}
          targets={accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind as "FACEBOOK_PAGE" | "INSTAGRAM_PROFILE", handle: a.handle }))}
          post={{
            id: post.id,
            text: post.text,
            linkUrl: post.linkUrl,
            targetIds: post.targets.map((t) => t.account.id),
            aiGenerated: post.aiGenerated,
            aiBrief: post.aiBrief,
          }}
          media={post.media.map((m) => ({ id: m.id, url: mediaPath(m.storageKey), width: m.width, height: m.height, name: m.originalName }))}
          ai={{ ...ai, canManage: can(user.role, "ai.manage") }}
        />
        <div className="mt-6 space-y-6">
          <PostActions postId={post.id} actions={actions} timezone={tz} {...times} scheduled={false} />
          <Card className="flex items-center justify-between gap-4 p-5">
            <p className="text-sm text-muted">Borrar este borrador no se puede deshacer.</p>
            <DeleteDraftForm postId={post.id} />
          </Card>
        </div>
        {history}
      </>
    );
  }

  return (
    <>
      {header}
      <Card className="space-y-5 p-5">
        <p className="whitespace-pre-wrap text-sm">{post.text}</p>
        {post.media.map((m) => (
          // Imagen dinamica servida por nuestra ruta /media: next/image no aporta nada aqui.
          // eslint-disable-next-line @next/next/no-img-element
          <img key={m.id} src={mediaPath(m.storageKey)} alt="Imagen de la publicación" className="max-h-72 max-w-full rounded-lg border border-border" />
        ))}
        {post.linkUrl && (
          <p className="text-sm">
            <span className="text-muted">Enlace: </span>
            {post.linkUrl}
          </p>
        )}
        {post.scheduledAt && (status === "SCHEDULED" || status === "PUBLISHING") && (
          <p className="text-sm">
            <span className="text-muted">Programada para: </span>
            <strong>{whenFmt.format(post.scheduledAt)}</strong> <span className="text-muted">(hora de {tz.replace(/_/g, " ")})</span>
          </p>
        )}
        {post.publishedAt && (
          <p className="text-sm">
            <span className="text-muted">Publicada: </span>
            {dateFmt.format(post.publishedAt)}
          </p>
        )}
        {post.reviewNote && status !== "DRAFT" && (
          <p className="text-sm">
            <span className="text-muted">Nota de revisión{post.reviewedBy ? ` (${post.reviewedBy.name})` : ""}: </span>
            {post.reviewNote}
          </p>
        )}
        <div>
          <h2 className="mb-2 text-sm font-semibold">Destinos</h2>
          {post.targets.length === 0 ? (
            <p className="text-sm text-muted">Sin destinos.</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {post.targets.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <span className="font-medium">{t.account.name}</span>
                  <span className="text-xs text-muted">{ACCOUNT_KIND_LABELS[t.account.kind]}</span>
                  <Badge tone={t.status === "PUBLISHED" ? "success" : t.status === "FAILED" ? "danger" : "neutral"}>
                    {TARGET_STATUS_LABELS[t.status]}
                  </Badge>
                  {t.status === "PENDING" && t.nextAttemptAt && (
                    <span className="text-xs text-muted">reintento {dateFmt.format(t.nextAttemptAt)}</span>
                  )}
                  {t.externalUrl && t.status === "PUBLISHED" && (
                    <a href={t.externalUrl} target="_blank" rel="noopener noreferrer" className="ml-auto text-xs text-primary hover:underline">
                      Ver publicación
                    </a>
                  )}
                  {t.error && (
                    <span className="basis-full text-xs text-danger">
                      {t.error}{" "}
                      <Link href="/manual#problemas" className="font-medium underline">
                        Ver qué hacer
                      </Link>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      {actions.length > 0 && (
        <div className="mt-6">
          <PostActions postId={post.id} actions={actions} timezone={tz} {...times} scheduled={status === "SCHEDULED"} />
        </div>
      )}
      {history}
    </>
  );
}
