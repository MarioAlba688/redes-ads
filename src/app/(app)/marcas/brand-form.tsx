"use client";

import { useActionState } from "react";
import { deleteBrand, saveBrand } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { Alert, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { COMMON_TIMEZONES } from "@/lib/brands";
import { LANGUAGES } from "@/lib/ai/limits";
import { ACCOUNT_KIND_LABELS, PLATFORM_NAMES } from "@/lib/platforms";

export type BrandValues = {
  id?: string;
  name: string;
  description: string;
  audience: string | null;
  tone: string | null;
  products: string | null;
  avoid: string | null;
  hashtags: string | null;
  callToAction: string | null;
  language: string;
  timezone: string;
};

export type AccountOption = {
  id: string;
  name: string;
  kind: keyof typeof ACCOUNT_KIND_LABELS;
  platform: keyof typeof PLATFORM_NAMES;
  handle: string | null;
  brandId: string | null;
  brandName: string | null;
  revoked: boolean;
};

const EMPTY: BrandValues = {
  name: "",
  description: "",
  audience: null,
  tone: null,
  products: null,
  avoid: null,
  hashtags: null,
  callToAction: null,
  language: "es",
  timezone: "America/Bogota",
};

export function BrandForm({
  brand,
  accounts,
  selectedIds,
}: {
  brand?: BrandValues;
  accounts: AccountOption[];
  selectedIds: string[];
}) {
  const [state, action] = useActionState(saveBrand, undefined);
  const e = state?.fieldErrors;
  const v = (key: keyof BrandValues): string => state?.values?.[key] ?? (brand ?? EMPTY)[key]?.toString() ?? "";
  const timezones = [...new Set([v("timezone"), ...COMMON_TIMEZONES])];
  // Tras un error, las cuentas que la persona habia marcado (ver saveBrand).
  const selected = new Set(state?.values?.accountIds !== undefined ? state.values.accountIds.split(",").filter(Boolean) : selectedIds);

  return (
    <form action={action} className="space-y-6" noValidate>
      {brand?.id && <input type="hidden" name="id" value={brand.id} />}
      {state?.error && <Alert>{state.error}</Alert>}
      {state?.success && <Alert tone="success">{state.success}</Alert>}

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Cómo es la marca</h2>
          <p className="text-sm text-muted">
            La IA lee esto antes de escribir cada publicación. Entre más concreto, mejores textos y menos correcciones.
          </p>
        </div>
        <Field label="Nombre de la marca" htmlFor="name" errors={e?.name}>
          <Input id="name" name="name" defaultValue={v("name")} placeholder="Ej. Reservi" required />
        </Field>
        <Field
          label="¿Qué hace el negocio?"
          htmlFor="description"
          hint="Qué vende o qué servicio da, y qué lo hace distinto."
          errors={e?.description}
        >
          <Textarea id="description" name="description" defaultValue={v("description")} rows={4} required />
        </Field>
        <Field label="¿A quién le habla?" htmlFor="audience" hint="Tu cliente ideal: quién es, dónde está, qué le importa." errors={e?.audience}>
          <Textarea id="audience" name="audience" defaultValue={v("audience")} rows={2} />
        </Field>
        <Field
          label="Tono y voz"
          htmlFor="tone"
          hint="Cercano, formal, divertido, directo… puedes dar un ejemplo de cómo hablaría la marca."
          errors={e?.tone}
        >
          <Textarea id="tone" name="tone" defaultValue={v("tone")} rows={2} />
        </Field>
        <Field
          label="Productos, servicios y ofertas que se pueden mencionar"
          htmlFor="products"
          hint="La IA no inventará precios ni promociones: solo usará lo que escribas aquí o en cada petición."
          errors={e?.products}
        >
          <Textarea id="products" name="products" defaultValue={v("products")} rows={3} />
        </Field>
        <Field
          label="Palabras o temas que nunca deben aparecer"
          htmlFor="avoid"
          hint="Uno por línea (o separados por comas). Si la IA las usa, esa opción se descarta."
          errors={e?.avoid}
        >
          <Textarea id="avoid" name="avoid" defaultValue={v("avoid")} rows={2} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Hashtags de la marca" htmlFor="hashtags" hint="Separados por espacios. Ej. #reservi #agenda" errors={e?.hashtags}>
            <Input id="hashtags" name="hashtags" defaultValue={v("hashtags")} />
          </Field>
          <Field label="Llamado a la acción habitual" htmlFor="callToAction" hint="Ej. Reserva tu cita hoy" errors={e?.callToAction}>
            <Input id="callToAction" name="callToAction" defaultValue={v("callToAction")} />
          </Field>
          <Field label="Idioma de las publicaciones" htmlFor="language" errors={e?.language}>
            <Select id="language" name="language" defaultValue={v("language")}>
              {Object.entries(LANGUAGES).map(([code, label]) => (
                <option key={code} value={code}>
                  {label[0].toUpperCase() + label.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Zona horaria" htmlFor="timezone" hint="La hora en la que programas las publicaciones." errors={e?.timezone}>
            <Select id="timezone" name="timezone" defaultValue={v("timezone")}>
              {timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold">Cuentas de esta marca</h2>
        <p className="mb-3 text-sm text-muted">
          Las páginas y cuentas de Instagram marcadas aquí son donde se publica. Una cuenta pertenece a una sola marca.
        </p>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted">Todavía no hay cuentas conectadas. Conéctalas en la sección Cuentas.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {accounts.map((a) => {
              const other = a.brandId && a.brandId !== brand?.id;
              const disabled = other || a.revoked;
              return (
                <li key={a.id}>
                  <label className={`flex items-center gap-3 px-3 py-2.5 text-sm ${disabled ? "opacity-60" : "cursor-pointer"}`}>
                    <input
                      type="checkbox"
                      name="accountId"
                      value={a.id}
                      defaultChecked={selected.has(a.id)}
                      disabled={disabled}
                      className="size-4 accent-[var(--primary)]"
                    />
                    <span className="font-medium">{a.name}</span>
                    {a.handle && <span className="text-muted">{a.handle}</span>}
                    <span className="ml-auto text-xs text-muted">
                      {ACCOUNT_KIND_LABELS[a.kind]} · {PLATFORM_NAMES[a.platform]}
                      {other ? ` · de «${a.brandName}»` : a.revoked ? " · desconectada" : ""}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="flex items-center gap-3">
        <SubmitButton pendingText="Guardando…">{brand?.id ? "Guardar cambios" : "Crear marca"}</SubmitButton>
      </div>
    </form>
  );
}

export function DeleteBrandForm({ brandId }: { brandId: string }) {
  const [state, action] = useActionState(deleteBrand, undefined);
  return (
    <form
      action={action}
      onSubmit={(ev) => {
        if (!window.confirm("¿Eliminar esta marca? Sus cuentas quedan sin marca. No se puede deshacer.")) ev.preventDefault();
      }}
      className="space-y-2"
    >
      <input type="hidden" name="id" value={brandId} />
      {state?.error && <Alert>{state.error}</Alert>}
      <SubmitButton variant="danger" pendingText="Eliminando…">
        Eliminar marca
      </SubmitButton>
    </form>
  );
}
