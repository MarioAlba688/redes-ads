"use client";

import { useActionState, useState, startTransition } from "react";
import { Alert, Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { budgetDecimals, parseBudgetInput } from "@/lib/promotions/currency";
import { DEFAULT_TARGETING } from "@/lib/promotions/targeting";
import {
  CTA_OPTIONS,
  MAX_DURATION_DAYS,
  MIN_DURATION_DAYS,
  OBJECTIVES_BY_KIND,
  OBJECTIVE_HINTS,
  OBJECTIVE_LABELS,
  type CtaType,
  type PromotionKindName,
  type PromotionObjectiveName,
  type Targeting,
} from "@/lib/promotions/types";
import { maxTotalSpend, validatePromotion } from "@/lib/promotions/validate";
import { createPromotionAction } from "./actions";
import { TargetingPicker } from "./targeting-picker";

export type AccountOption = {
  id: string;
  name: string;
  currency: string | null;
  cap: number | null;
  /** Tope de gasto por mes (null = sin tope mensual) y lo gastado en el mes en curso. */
  monthlyCap: number | null;
  spentThisMonth: number;
  brandId: string | null;
  blocked: string | null;
};
export type BoostOption = { targetId: string; label: string; brandId: string };
export type PostOption = {
  id: string;
  label: string;
  text: string;
  brandId: string;
  /** Tiene imagen registrada Y su archivo esta en este servidor. */
  hasImage: boolean;
  /** Esta registrada pero su archivo se perdio (hay que restaurarla en la publicacion). */
  imageMissing: boolean;
};
export type PageOption = { id: string; name: string; brandId: string };

const excerpt = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function PromotionForm({
  kind,
  accounts,
  boosts,
  posts,
  pages,
  initialSourceId,
}: {
  kind: PromotionKindName;
  accounts: AccountOption[];
  boosts: BoostOption[];
  posts: PostOption[];
  pages: PageOption[];
  initialSourceId: string | null;
}) {
  const [state, action, pending] = useActionState(createPromotionAction, undefined);

  const sources = kind === "BOOST" ? boosts.map((b) => ({ id: b.targetId, label: b.label, brandId: b.brandId })) : posts.map((p) => ({ id: p.id, label: p.label, brandId: p.brandId }));
  const [sourceId, setSourceId] = useState(initialSourceId && sources.some((s) => s.id === initialSourceId) ? initialSourceId : "");
  const source = sources.find((s) => s.id === sourceId) ?? null;
  const post = kind === "AD" ? (posts.find((p) => p.id === sourceId) ?? null) : null;

  // La cuenta publicitaria por defecto es la de la marca de la publicacion; si no hay, la primera que se pueda usar.
  const usable = accounts.filter((a) => !a.blocked);
  const [accountPick, setAccountPick] = useState<string>("");
  const accountId = accountPick || (usable.find((a) => a.brandId && a.brandId === source?.brandId) ?? usable[0])?.id || "";
  const account = accounts.find((a) => a.id === accountId) ?? null;

  const pageChoices = pages.filter((p) => !source || p.brandId === source.brandId);
  const [pagePick, setPagePick] = useState("");
  const pageAccountId = pageChoices.some((p) => p.id === pagePick) ? pagePick : (pageChoices[0]?.id ?? "");

  const objectives = OBJECTIVES_BY_KIND[kind];
  const [objective, setObjective] = useState<PromotionObjectiveName>(objectives[0]);
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const autoName = source ? `${kind === "BOOST" ? "Impulso" : "Anuncio"}: ${excerpt(source.label.split(" · ")[0], 60)}` : "";
  const name = nameEdit ?? autoName;
  const [budgetText, setBudgetText] = useState("");
  const [days, setDays] = useState(7);
  const [targeting, setTargeting] = useState<Targeting>(DEFAULT_TARGETING);
  const [messageEdit, setMessageEdit] = useState<string | null>(null);
  const message = messageEdit ?? post?.text ?? "";
  const [headline, setHeadline] = useState("");
  const [link, setLink] = useState("");
  const [cta, setCta] = useState<CtaType>("LEARN_MORE");
  const [showErrors, setShowErrors] = useState(false);

  const currency = account?.currency ?? null;
  const budget = parseBudgetInput(budgetText, currency);

  // Se recalcula en cada vuelta: es barato y asi nunca queda desfasado de lo que se esta escribiendo.
  const errors = (() => {
    const list: string[] = [];
    if (!source) list.push(kind === "BOOST" ? "Elige la publicación que quieres impulsar." : "Elige la publicación de la que sale el anuncio.");
    if (!account) list.push("Elige una cuenta publicitaria.");
    else if (account.blocked) list.push(account.blocked);
    if (post?.imageMissing) list.push("La imagen de esa publicación ya no está en el servidor: vuelve a subirla en la publicación o elige otra.");
    if (kind === "AD" && !pageAccountId) list.push("Esa marca no tiene una página de Facebook conectada para publicar el anuncio.");
    if (budgetText.trim() === "") list.push("Escribe el presupuesto diario.");
    else if (budget === null) list.push(`No entiendo el presupuesto «${budgetText}»: escríbelo en ${currency ?? "la moneda de la cuenta"}${budgetDecimals(currency) === 0 ? " sin decimales (50000 o 50.000)" : " con hasta 2 decimales (10,50)"}.`);
    list.push(
      ...validatePromotion(
        {
          kind,
          objective,
          name,
          dailyBudget: budget ?? 0,
          durationDays: days,
          targeting,
          creative: { message, headline: headline.trim() || null, link: link.trim() || null, cta, imageKey: post?.hasImage ? "x" : null },
        },
        { currency, cap: account?.cap ?? null, hasImage: kind === "AD" ? ((post?.hasImage ?? false) || (post?.imageMissing ?? false)) : undefined },
      ).filter((e) => !(budget === null && /presupuesto diario (debe|en)/i.test(e))),
    );
    return Array.from(new Set(list));
  })();

  const total = budget !== null ? maxTotalSpend(budget, days, currency) : null;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (errors.length > 0) {
      setShowErrors(true);
      return;
    }
    const payload = {
      adAccountId: accountId,
      kind,
      ...(kind === "BOOST" ? { targetId: sourceId } : { postId: sourceId, pageAccountId }),
      objective,
      name: name.trim(),
      dailyBudget: budgetText,
      durationDays: days,
      targeting,
      creative: kind === "AD" ? { message, headline: headline.trim() || null, link: link.trim() || null, cta } : { message: "", headline: null, link: null, cta: null },
    };
    const fd = new FormData();
    fd.set("payload", JSON.stringify(payload));
    startTransition(() => action(fd));
  }

  if (usable.length === 0) {
    return (
      <Alert tone="warning">
        {accounts.length === 0
          ? "No hay cuentas publicitarias de Meta conectadas. Conecta Meta en Cuentas."
          : `Ninguna cuenta publicitaria está lista para crear anuncios: ${accounts.map((a) => `${a.name} (${a.blocked})`).join(" · ")}`}
      </Alert>
    );
  }
  if (sources.length === 0) {
    return (
      <Alert tone="warning">
        {kind === "BOOST" ? "Todavía no hay publicaciones publicadas que se puedan impulsar. Publica algo primero." : "Todavía no hay publicaciones con las que armar un anuncio. Crea una en Publicaciones."}
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <Alert tone="success">
        El anuncio se crea <strong>en pausa</strong>: no gasta nada hasta que una persona con permiso de aprobar lo active. El presupuesto nunca puede pasar del tope que fijó el administrador para la cuenta.
      </Alert>

      <Card className="space-y-4 p-5">
        <h2 className="font-semibold">{kind === "BOOST" ? "¿Qué publicación quieres impulsar?" : "¿De qué publicación sale el anuncio?"}</h2>
        <Field label="Publicación" htmlFor="fuente" hint={kind === "AD" ? "Se usa su texto y su imagen; no se publica en tu página." : "Solo aparecen las que ya están publicadas en Facebook o Instagram."}>
          <Select id="fuente" value={sourceId} onChange={(e) => setSourceId(e.target.value)} disabled={pending}>
            <option value="">Elige una publicación…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Cuenta publicitaria" htmlFor="cuenta" hint="La que paga el anuncio.">
          <Select id="cuenta" value={accountId} onChange={(e) => setAccountPick(e.target.value)} disabled={pending}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id} disabled={!!a.blocked}>
                {a.name} {a.currency ? `(${a.currency})` : ""} {a.blocked ? `— ${a.blocked}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        {kind === "AD" && (
          <Field label="Página de Facebook" htmlFor="pagina" hint="El anuncio sale a nombre de esta página (y de su Instagram vinculado, si lo hay).">
            <Select id="pagina" value={pageAccountId} onChange={(e) => setPagePick(e.target.value)} disabled={pending || pageChoices.length === 0}>
              {pageChoices.length === 0 && <option value="">Sin páginas conectadas para esta marca</option>}
              {pageChoices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="font-semibold">¿Qué quieres conseguir?</h2>
        <div role="radiogroup" aria-label="Objetivo" className="grid gap-2 sm:grid-cols-3">
          {objectives.map((o) => (
            <label key={o} className={`cursor-pointer rounded-lg border p-3 text-sm transition-colors ${objective === o ? "border-primary bg-primary/5" : "border-border hover:bg-background"}`}>
              <input type="radio" name="objetivo" className="sr-only" checked={objective === o} onChange={() => setObjective(o)} disabled={pending} />
              <span className="block font-medium">{OBJECTIVE_LABELS[o]}</span>
              <span className="mt-1 block text-xs text-muted">{OBJECTIVE_HINTS[o]}</span>
            </label>
          ))}
        </div>
        <Field label="Nombre del anuncio" htmlFor="nombre" hint="Es el que verás en las listas y en Meta.">
          <Input id="nombre" value={name} onChange={(e) => setNameEdit(e.target.value)} maxLength={200} disabled={pending} />
        </Field>
      </Card>

      {kind === "AD" && (
        <Card className="space-y-4 p-5">
          <h2 className="font-semibold">El anuncio</h2>
          {post && post.imageMissing && (
            <Alert tone="warning">
              La imagen de esa publicación ya no está en el servidor (se pierde si el servidor se redespliega sin un volumen para las imágenes).{" "}
              <a href={`/publicaciones/${post.id}`} className="font-medium underline">
                Abre la publicación para volver a subirla
              </a>
              , o elige otra.
            </Alert>
          )}
          {post && !post.hasImage && !post.imageMissing && <Alert tone="warning">Esa publicación no tiene imagen: el anuncio la necesita. Agrégale una en Publicaciones.</Alert>}
          <Field label="Texto" htmlFor="texto">
            <Textarea id="texto" value={message} onChange={(e) => setMessageEdit(e.target.value)} rows={5} disabled={pending} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Titular (opcional)" htmlFor="titular">
              <Input id="titular" value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={255} disabled={pending} />
            </Field>
            <Field label="Botón" htmlFor="boton">
              <Select id="boton" value={cta} onChange={(e) => setCta(e.target.value as CtaType)} disabled={pending}>
                {CTA_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={objective === "TRAFFIC" ? "Enlace (obligatorio)" : "Enlace (opcional)"} htmlFor="enlace" hint="La dirección a la que lleva el anuncio, completa: https://tusitio.com">
            <Input id="enlace" type="url" inputMode="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" disabled={pending} />
          </Field>
        </Card>
      )}

      <Card className="space-y-4 p-5">
        <h2 className="font-semibold">Presupuesto y duración</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={`Presupuesto por día${currency ? ` (${currency})` : ""}`}
            htmlFor="presupuesto"
            hint={account?.cap != null ? `Tope de esta cuenta: ${formatMoney(account.cap, currency ?? "")} por día.` : undefined}
          >
            <Input id="presupuesto" inputMode="decimal" autoComplete="off" value={budgetText} onChange={(e) => setBudgetText(e.target.value)} placeholder={budgetDecimals(currency) === 0 ? "20000" : "10,50"} disabled={pending} />
          </Field>
          <Field label="Duración (días)" htmlFor="dias" hint={`De ${MIN_DURATION_DAYS} a ${MAX_DURATION_DAYS}. Cuenta desde que se activa.`}>
            <Input id="dias" type="number" min={MIN_DURATION_DAYS} max={MAX_DURATION_DAYS} value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={pending} />
          </Field>
        </div>
        {account?.monthlyCap != null && (
          <p className="text-sm text-muted">
            Tope mensual de esta cuenta: <strong className="text-foreground">{formatMoney(account.monthlyCap, currency ?? "")}</strong> · gastado este mes: {formatMoney(account.spentThisMonth, currency ?? "")}. Al activar, la app comprueba que este anuncio quepa en lo que queda del mes.
          </p>
        )}
        {account && account.cap === null && <Alert tone="warning">Esta cuenta todavía no tiene un tope de gasto diario. Pídele al administrador que lo fije en Cuentas: sin él no se puede crear el anuncio.</Alert>}
        {total !== null && budget !== null && (
          <p className="text-sm">
            Gasto máximo posible: <strong>{formatMoney(total, currency ?? "")}</strong>{" "}
            <span className="text-muted">
              ({formatMoney(budget, currency ?? "")} por día × {days} {days === 1 ? "día" : "días"}). Meta puede gastar menos.
            </span>
          </p>
        )}
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="font-semibold">¿A quién se le muestra?</h2>
        <TargetingPicker value={targeting} onChange={setTargeting} accountId={accountId || null} disabled={pending} />
      </Card>

      {showErrors && errors.length > 0 && (
        <Alert>
          <p className="font-medium">Falta revisar:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
      {state?.error && (
        <Alert>
          <ul className="list-disc space-y-0.5 pl-5">
            {state.error.split("\n").map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Creando en Meta… (puede tardar unos segundos)" : "Crear anuncio (en pausa)"}
        </Button>
      </div>
    </form>
  );
}
