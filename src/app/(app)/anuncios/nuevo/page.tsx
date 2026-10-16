import type { Metadata } from "next";
import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { dateTimeFormat } from "@/lib/display-time";
import { imageExists } from "@/lib/media";
import { missingAdsWriteScope } from "@/lib/meta/scopes";
import { budgetDecimals } from "@/lib/promotions/currency";
import { failureHints } from "@/lib/promotions/hints";
import type { CreativeInput, PromotionKindName, Targeting } from "@/lib/promotions/types";
import { monthSpendByAccount } from "@/lib/promotions/spend";
import { POST_STATUS_LABELS, type PostStatusName } from "@/lib/posts";
import { PromotionForm, type AccountOption, type BoostOption, type PageOption, type PostOption } from "../promotion-form";

export const metadata: Metadata = { title: "Crear anuncio" };

const excerpt = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Por que una cuenta publicitaria no se puede usar todavia (null = lista). El tope sin fijar se avisa en el formulario. */
function blockedReason(a: { status: string; scopes: string | null; currency: string | null; metadata: unknown }): string | null {
  if (a.status !== "ACTIVE") return "conexión vencida: reconecta Meta";
  if (missingAdsWriteScope(a.scopes)) return "falta el permiso ads_management";
  if (budgetDecimals(a.currency) === null) return `moneda ${a.currency ?? "desconocida"} no admitida`;
  const state = (a.metadata as { accountStatus?: unknown } | null)?.accountStatus;
  if (typeof state === "number" && state !== 1) return "cuenta no activa en Meta";
  return null;
}

export default async function NewPromotionPage({ searchParams }: PageProps<"/anuncios/nuevo">) {
  await requireUser("ads.create");
  const q = await searchParams;
  // «Crear de nuevo»: parte de un anuncio que no se pudo crear (sus datos precargados para corregirlos).
  const copyId = typeof q.copiar === "string" ? q.copiar : null;
  const copy = copyId
    ? await db.adPromotion.findUnique({
        where: { id: copyId },
        select: { kind: true, objective: true, name: true, adAccountId: true, postId: true, targetId: true, dailyBudget: true, durationDays: true, targeting: true, creative: true, error: true, status: true },
      })
    : null;
  const kind: PromotionKindName = copy ? (copy.kind as PromotionKindName) : q.tipo === "anuncio" ? "AD" : "BOOST";
  const initial = copy ? (copy.kind === "BOOST" ? copy.targetId : copy.postId) : typeof q.destino === "string" ? q.destino : typeof q.publicacion === "string" ? q.publicacion : null;
  const dayFmt = dateTimeFormat({ time: false });

  const [adAccounts, pageAccounts, targets, posts] = await Promise.all([
    db.socialAccount.findMany({
      where: { platform: "META", kind: "AD_ACCOUNT", status: { not: "REVOKED" } },
      select: { id: true, name: true, currency: true, dailyBudgetCap: true, monthlyBudgetCap: true, timezone: true, brandId: true, status: true, scopes: true, metadata: true },
      orderBy: { name: "asc" },
    }),
    db.socialAccount.findMany({
      where: { platform: "META", kind: "FACEBOOK_PAGE", status: "ACTIVE", brandId: { not: null } },
      select: { id: true, name: true, brandId: true },
      orderBy: { name: "asc" },
    }),
    kind === "BOOST"
      ? db.postTarget.findMany({
          where: { status: "PUBLISHED", externalId: { not: null }, account: { kind: { in: ["FACEBOOK_PAGE", "INSTAGRAM_PROFILE"] } } },
          orderBy: { publishedAt: "desc" },
          take: 60,
          select: { id: true, publishedAt: true, account: { select: { name: true, kind: true } }, post: { select: { text: true, brandId: true } } },
        })
      : Promise.resolve([]),
    kind === "AD"
      ? db.post.findMany({
          where: { status: { not: "CANCELLED" } },
          orderBy: { createdAt: "desc" },
          take: 60,
          select: { id: true, text: true, brandId: true, status: true, media: { take: 1, orderBy: { position: "asc" }, select: { storageKey: true } } },
        })
      : Promise.resolve([]),
  ]);

  // La publicacion de origen puede ser mas vieja que las 60 mas recientes que se ofrecen: se agrega para que quede elegida.
  const extraTarget =
    kind === "BOOST" && initial && !targets.some((t) => t.id === initial)
      ? await db.postTarget.findFirst({
          where: { id: initial, status: "PUBLISHED", externalId: { not: null } },
          select: { id: true, publishedAt: true, account: { select: { name: true, kind: true } }, post: { select: { text: true, brandId: true } } },
        })
      : null;
  const targetRows = extraTarget ? [...targets, extraTarget] : targets;
  const extraPost =
    kind === "AD" && initial && !posts.some((p) => p.id === initial)
      ? await db.post.findFirst({
          where: { id: initial, status: { not: "CANCELLED" } },
          select: { id: true, text: true, brandId: true, status: true, media: { take: 1, orderBy: { position: "asc" }, select: { storageKey: true } } },
        })
      : null;
  const postRows = extraPost ? [...posts, extraPost] : posts;

  const monthSpent = await monthSpendByAccount(adAccounts);
  const accounts: AccountOption[] = adAccounts.map((a) => ({
    id: a.id,
    name: a.name,
    currency: a.currency,
    cap: a.dailyBudgetCap === null ? null : Number(a.dailyBudgetCap),
    monthlyCap: a.monthlyBudgetCap === null ? null : Number(a.monthlyBudgetCap),
    spentThisMonth: monthSpent.get(a.id) ?? 0,
    brandId: a.brandId,
    blocked: blockedReason(a),
  }));
  const boosts: BoostOption[] = targetRows.map((t) => ({
    targetId: t.id,
    brandId: t.post.brandId,
    label: `${excerpt(t.post.text, 70)} · ${t.account.kind === "INSTAGRAM_PROFILE" ? "Instagram" : "Facebook"} ${t.account.name}${t.publishedAt ? ` · ${dayFmt.format(t.publishedAt)}` : ""}`,
  }));
  // La imagen cuenta si esta registrada Y su archivo esta en este servidor (si no, hay que restaurarla).
  const fileThere = await Promise.all(postRows.map((p) => (p.media[0] ? imageExists(p.media[0].storageKey) : Promise.resolve(false))));
  const postOptions: PostOption[] = postRows.map((p, i) => {
    const registered = p.media.length > 0;
    const imageMissing = registered && !fileThere[i];
    return {
      id: p.id,
      brandId: p.brandId,
      text: p.text,
      hasImage: registered && !imageMissing,
      imageMissing,
      label: `${excerpt(p.text, 70)} · ${POST_STATUS_LABELS[p.status as PostStatusName] ?? p.status}${!registered ? " · sin imagen" : imageMissing ? " · imagen perdida" : ""}`,
    };
  });
  const pages: PageOption[] = pageAccounts.map((p) => ({ id: p.id, name: p.name, brandId: p.brandId as string }));

  const copyAccount = copy ? adAccounts.find((a) => a.id === copy.adAccountId) : null;
  const copyCreative = copy ? (copy.creative as unknown as Partial<CreativeInput>) : null;
  const copyForm = copy
    ? {
        accountId: copy.adAccountId,
        objective: copy.objective,
        name: copy.name,
        budgetText: String(Number(copy.dailyBudget)),
        days: copy.durationDays,
        targeting: copy.targeting as unknown as Targeting,
        message: copyCreative?.message ?? "",
        headline: copyCreative?.headline ?? "",
        link: copyCreative?.link ?? "",
        cta: copyCreative?.cta ?? "LEARN_MORE",
      }
    : undefined;
  const copyNotice = copy
    ? {
        error: copy.error,
        hints: failureHints(copy.error, { dailyCap: copyAccount?.dailyBudgetCap == null ? null : Number(copyAccount.dailyBudgetCap), currency: copyAccount?.currency ?? "" }),
        sourceGone: !initial,
      }
    : undefined;

  const tab = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`rounded-md px-3 py-1.5 transition-colors ${active ? "bg-primary/10 font-semibold text-primary" : "text-muted hover:text-foreground"}`}
    >
      {label}
    </Link>
  );

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/anuncios/creados" className="text-muted hover:text-foreground">
          ← Anuncios creados
        </Link>
      </p>
      <PageHeader title={copy ? "Crear de nuevo un anuncio" : "Crear anuncio"} description="Facebook e Instagram. Se crea en pausa y lo activa quien aprueba; nunca pasa del tope diario de la cuenta." />
      {!copy && (
        <div role="group" aria-label="Tipo de anuncio" className="mb-6 inline-flex rounded-lg border border-border bg-surface p-0.5 text-sm">
          {tab("/anuncios/nuevo?tipo=impulsar", "Impulsar una publicación", kind === "BOOST")}
          {tab("/anuncios/nuevo?tipo=anuncio", "Anuncio nuevo", kind === "AD")}
        </div>
      )}
      {kind === "BOOST" ? (
        <p className="mb-4 max-w-2xl text-sm text-muted">Promociona una publicación que ya salió en tu página o en tu Instagram para que más gente la vea o interactúe con ella.</p>
      ) : (
        <p className="mb-4 max-w-2xl text-sm text-muted">Arma un anuncio con el texto y la imagen de una publicación, con enlace y botón. No se publica en tu página: solo existe como anuncio.</p>
      )}
      <Card className="border-0 bg-transparent">
        <PromotionForm key={`${kind}-${copyId ?? ""}`} kind={kind} accounts={accounts} boosts={boosts} posts={postOptions} pages={pages} initialSourceId={initial} initial={copyForm} copyNotice={copyNotice} />
      </Card>
    </>
  );
}
