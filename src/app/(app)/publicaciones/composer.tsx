"use client";

import { useActionState, useState, useTransition, type FormEvent } from "react";
import { createDraft, deleteDraft, generateAction, updateDraft } from "./actions";
import { MediaUploader, type MediaItem } from "./media-uploader";
import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Badge, Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import type { AiProviderId, EngineOption } from "@/lib/ai/catalog";
import { maxCharsFor, PLATFORM_LABELS, POST_PLATFORMS, type PostPlatform } from "@/lib/ai/limits";
import { textLength } from "@/lib/post-validation";
import { ACCOUNT_KIND_LABELS } from "@/lib/platforms";

export type ComposerTarget = { id: string; name: string; kind: "FACEBOOK_PAGE" | "INSTAGRAM_PROFILE"; handle: string | null };

export type ComposerProps = {
  brand: { id: string; name: string };
  targets: ComposerTarget[];
  post?: { id: string; text: string; linkUrl: string | null; targetIds: string[]; aiGenerated: boolean; aiBrief: string | null };
  media?: MediaItem[];
  ai: {
    configured: boolean;
    used: number;
    limit: number;
    /** Motores entre los que se puede elegir y el que se propone primero. */
    engines: EngineOption[];
    defaultEngine: AiProviderId | null;
    /** La persona puede abrir «Motores de IA» para configurarlos (es administradora). */
    canManage: boolean;
  };
};

/** Plataforma que conviene pedirle a la IA segun donde se va a publicar. */
function platformFor(kinds: string[]): PostPlatform {
  const fb = kinds.includes("FACEBOOK_PAGE");
  const ig = kinds.includes("INSTAGRAM_PROFILE");
  if (fb && !ig) return "facebook";
  if (ig && !fb) return "instagram";
  return "both";
}

export function Composer({ brand, targets, post, media = [], ai }: ComposerProps) {
  const [text, setText] = useState(post?.text ?? "");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(post ? post.targetIds : targets.map((t) => t.id)));
  const [fromAi, setFromAi] = useState(post?.aiGenerated ?? false);
  const [aiBrief, setAiBrief] = useState(post?.aiBrief ?? "");
  const [platformOverride, setPlatformOverride] = useState<PostPlatform | null>(null);
  const [engine, setEngine] = useState<string>(ai.defaultEngine ?? ai.engines[0]?.id ?? "");

  const [aiState, aiAction, aiPending] = useActionState(generateAction, undefined);
  const [saveState, saveAction, savePending] = useActionState(post ? updateDraft : createDraft, undefined);
  const [, startTransition] = useTransition();

  /**
   * Envia el formulario a mano en lugar de con `<form action>`. Con `action`, React 19 vacia el formulario
   * despues de cada envio, incluidos los campos que controlamos con estado (el desplegable «Para» volvia a
   * «Facebook» y los destinos marcados se perdian). Asi los campos quedan como la persona los dejo.
   */
  const submitWith = (action: (data: FormData) => void) => (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const data = new FormData(ev.currentTarget);
    startTransition(() => action(data));
  };

  const kinds = targets.filter((t) => selected.has(t.id)).map((t) => t.kind);
  const platform = platformOverride ?? platformFor(kinds);
  const max = maxCharsFor(kinds);
  const len = textLength(text);
  const over = len > max;
  const e = saveState?.fieldErrors;
  const usageLeft = ai.limit - (aiState?.usage?.used ?? ai.used);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      {/* ------------------------------ Editor ------------------------------ */}
      <div className="space-y-5">
      <form onSubmit={submitWith(saveAction)} className="space-y-5" noValidate>
        <Card className="space-y-4 p-5">
          {post && <input type="hidden" name="id" value={post.id} />}
          <input type="hidden" name="brandId" value={brand.id} />
          <input type="hidden" name="aiGenerated" value={String(fromAi)} />
          <input type="hidden" name="aiBrief" value={aiBrief} />
          {saveState?.error && <Alert>{saveState.error}</Alert>}
          {saveState?.success && <Alert tone="success">{saveState.success}</Alert>}

          <Field label="Texto de la publicación" htmlFor="text" errors={e?.text}>
            <Textarea
              id="text"
              name="text"
              value={text}
              onChange={(ev) => setText(ev.target.value)}
              rows={10}
              required
              aria-describedby="text-count"
            />
          </Field>
          <p id="text-count" className={`-mt-2 text-right text-xs tabular-nums ${over ? "font-medium text-danger" : "text-muted"}`}>
            {len.toLocaleString("es")} / {max.toLocaleString("es")} caracteres
            {kinds.includes("INSTAGRAM_PROFILE") ? " (límite de Instagram)" : ""}
          </p>

          <Field
            label="Enlace (opcional)"
            htmlFor="linkUrl"
            hint="Solo se muestra en Facebook; en Instagram los enlaces del texto no se pueden pulsar."
            errors={e?.linkUrl}
          >
            <Input id="linkUrl" name="linkUrl" type="url" defaultValue={post?.linkUrl ?? ""} placeholder="https://" />
          </Field>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold">¿Dónde se publica?</h2>
          {targets.length === 0 ? (
            <p className="mt-2 text-sm text-muted">
              Esta marca todavía no tiene páginas de Facebook ni cuentas de Instagram. Puedes guardar el borrador y asignarlas luego
              desde la ficha de la marca.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
              {targets.map((t) => (
                <li key={t.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
                    <input
                      type="checkbox"
                      name="targetId"
                      value={t.id}
                      checked={selected.has(t.id)}
                      onChange={() => toggle(t.id)}
                      className="size-4 accent-[var(--primary)]"
                    />
                    <span className="font-medium">{t.name}</span>
                    {t.handle && <span className="text-muted">{t.handle}</span>}
                    <span className="ml-auto text-xs text-muted">{ACCOUNT_KIND_LABELS[t.kind]}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={over || savePending}>
            {savePending ? "Guardando…" : post ? "Guardar cambios" : "Guardar borrador"}
          </Button>
          {over && <span className="text-sm text-danger">Acorta el texto para poder guardarlo.</span>}
        </div>
      </form>

      {/* La imagen se sube aparte (fuera del formulario): necesita que el borrador ya exista. */}
      <Card className="p-5">
        {post ? (
          <MediaUploader postId={post.id} media={media} />
        ) : (
          <div>
            <h2 className="font-semibold">Imagen</h2>
            <p className="text-sm text-muted">Guarda el borrador primero y entonces podrás añadir una imagen.</p>
          </div>
        )}
      </Card>
      </div>

      {/* ------------------------------ Panel de IA ------------------------------ */}
      <aside className="space-y-4">
        <Card className="p-5">
          <h2 className="font-semibold">Escribir con IA</h2>
          <p className="mb-3 text-sm text-muted">
            Usa la voz de <strong>{brand.name}</strong>. Cuéntale de qué quieres publicar y elige la opción que más te guste.
          </p>

          {!ai.configured ? (
            <Alert tone="warning">
              La IA todavía no está activada.{" "}
              {ai.canManage ? (
                <>
                  Añade la clave de Claude, GPT o Gemini en{" "}
                  <Link href="/ia" className="font-medium underline">
                    Motores de IA
                  </Link>
                  .
                </>
              ) : (
                "Pídele a un administrador que añada la clave de un motor de IA."
              )}
            </Alert>
          ) : (
            <form onSubmit={submitWith(aiAction)} className="space-y-3" noValidate>
              <input type="hidden" name="brandId" value={brand.id} />
              {ai.engines.length === 1 && <input type="hidden" name="provider" value={ai.engines[0].id} />}
              {aiState?.error && <Alert>{aiState.error}</Alert>}
              {ai.engines.length > 1 && (
                <Field label="Motor de IA" htmlFor="provider">
                  <Select id="provider" name="provider" value={engine} onChange={(ev) => setEngine(ev.target.value)}>
                    {ai.engines.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="¿De qué quieres publicar?" htmlFor="brief">
                <Textarea
                  id="brief"
                  name="brief"
                  rows={4}
                  placeholder="Ej. Lanzamos el plan Pro con reservas ilimitadas. Quiero invitar a probarlo esta semana."
                  required
                />
              </Field>
              <div className="grid grid-cols-[5.5rem_1fr] gap-3">
                <Field label="Opciones" htmlFor="count">
                  <Select id="count" name="count" defaultValue="3">
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Para" htmlFor="platform">
                  <Select id="platform" name="platform" value={platform} onChange={(ev) => setPlatformOverride(ev.target.value as PostPlatform)}>
                    {POST_PLATFORMS.map((p) => (
                      <option key={p} value={p}>
                        {PLATFORM_LABELS[p]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Button type="submit" className="w-full" disabled={usageLeft <= 0 || aiPending}>
                {aiPending ? "Escribiendo… (puede tardar unos segundos)" : "Generar opciones"}
              </Button>
              <p className="text-xs text-muted">
                Llevas {aiState?.usage?.used ?? ai.used} de {ai.limit} generaciones en las últimas 24 horas.
              </p>
            </form>
          )}
        </Card>

        {aiState?.posts && (
          <div className="space-y-3" aria-live="polite">
            {aiState.engine && (
              <p className="text-xs text-muted">
                Escrito con {aiState.engine.label} · {aiState.engine.model}
              </p>
            )}
            {aiState.discarded ? (
              <p className="text-xs text-muted">
                Se descartaron {aiState.discarded} opción(es) por usar palabras que la marca pidió evitar.
              </p>
            ) : null}
            {aiState.posts.map((p, i) => (
              <Card key={i} className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone="primary">{p.angle || `Opción ${i + 1}`}</Badge>
                  <span className="text-xs tabular-nums text-muted">{p.length} caracteres</span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{p.fullText}</p>
                {p.imageIdea && <p className="text-xs italic text-muted">Imagen sugerida: {p.imageIdea}</p>}
                {p.warnings.map((w) => (
                  <p key={w} className="text-xs text-warning">
                    {w}
                  </p>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setText(p.fullText);
                    setFromAi(true);
                    setAiBrief(aiState.values?.brief ?? "");
                  }}
                  className="w-full rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-background"
                >
                  Usar este texto
                </button>
              </Card>
            ))}
            <p className="text-xs text-muted">Revisa siempre el texto: puedes editarlo antes de guardar.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

export function DeleteDraftForm({ postId }: { postId: string }) {
  const [state, action] = useActionState(deleteDraft, undefined);
  return (
    <form
      action={action}
      onSubmit={(ev) => {
        if (!window.confirm("¿Borrar esta publicación? No se puede deshacer.")) ev.preventDefault();
      }}
      className="space-y-2"
    >
      <input type="hidden" name="id" value={postId} />
      {state?.error && <Alert>{state.error}</Alert>}
      <SubmitButton variant="danger" small pendingText="Borrando…">
        Borrar
      </SubmitButton>
    </form>
  );
}
