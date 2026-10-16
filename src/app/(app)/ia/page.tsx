import type { Metadata } from "next";
import { Card, PageHeader } from "@/components/ui";
import { PROVIDERS } from "@/lib/ai/catalog";
import { loadEngineStatuses } from "@/lib/ai/providers";
import { defaultEngineId } from "@/lib/ai/providers-core";
import { requireUser } from "@/lib/auth/dal";
import { dateTimeFormat } from "@/lib/display-time";
import { env } from "@/lib/env";
import { DefaultEngineForm } from "./default-engine-form";
import { EngineCard } from "./engine-card";

export const metadata: Metadata = { title: "Motores de IA" };

export default async function EnginesPage() {
  await requireUser("ai.manage");
  const statuses = await loadEngineStatuses();
  const dateFmt = dateTimeFormat();
  const ready = statuses.filter((s) => s.ready);
  const explicitDefault = statuses.find((s) => s.isDefault && s.ready)?.id ?? "";

  return (
    <>
      <PageHeader
        title="Motores de IA"
        description="Elige con qué inteligencia artificial escribe el equipo. Puedes dejar varias configuradas y cada persona escoge cuál usar al crear una publicación."
      />

      <div className="mb-6 space-y-4">
        <Card className="p-5">
          {ready.length === 0 ? (
            <p className="text-sm text-muted">
              Todavía no hay ningún motor listo. Pega la clave de al menos uno y pulsa <strong>Guardar</strong>: el generador de textos del editor se activa solo.
            </p>
          ) : (
            // El key solo cambia cuando cambia QUE motores hay: remontar el formulario al guardar borraria el aviso de «Guardado».
            <DefaultEngineForm key={ready.map((r) => r.id).join()} ready={ready.map((r) => ({ id: r.id, label: r.label }))} current={explicitDefault} />
          )}
          <p className="mt-4 text-xs text-muted">
            Las claves se guardan <strong>cifradas</strong> en la base de datos y nunca se muestran de nuevo. Cada generación cuesta dinero en tu cuenta de ese proveedor: el límite de{" "}
            {env().AI_DAILY_LIMIT} generaciones por persona cada 24 horas (<code>AI_DAILY_LIMIT</code>) es común a todos los motores.
          </p>
        </Card>
      </div>

      <div className="space-y-6">
        {statuses.map((s) => (
          <EngineCard
            key={s.id}
            id={s.id}
            label={s.label}
            keyUrl={PROVIDERS[s.id].keyUrl}
            keyUrlLabel={PROVIDERS[s.id].keyUrlLabel}
            keyExample={PROVIDERS[s.id].keyExample}
            model={s.model}
            enabled={s.enabled}
            isDefault={s.id === defaultEngineId(statuses)}
            hasKey={s.hasKey}
            source={s.source}
            keyHint={s.keyHint}
            lastTest={s.lastTestAt && s.lastTestOk !== null ? { at: dateFmt.format(s.lastTestAt), ok: s.lastTestOk, error: s.lastError } : null}
          />
        ))}
      </div>
    </>
  );
}
