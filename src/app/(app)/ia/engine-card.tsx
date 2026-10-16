"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { loadModels, removeEngineKey, saveEngine, testEngine, type EngineResult } from "./actions";
import { Alert, Badge, Button, Card, Field, Input } from "@/components/ui";
import type { AiProviderId } from "@/lib/ai/catalog";

export type EngineCardProps = {
  id: AiProviderId;
  label: string;
  keyUrl: string;
  keyUrlLabel: string;
  keyExample: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  hasKey: boolean;
  source: "db" | "env" | null;
  keyHint: string | null;
  /** Ultima prueba de conexion, con la fecha ya formateada. */
  lastTest: { at: string; ok: boolean; error: string | null } | null;
};

type Busy = "save" | "test" | "models" | "remove" | null;

/**
 * Un motor de IA: clave, modelo y si esta activo. Se envia a mano (sin `<form action>`) para que React no vacie los
 * campos tras cada accion y porque un mismo formulario alimenta cuatro acciones (guardar, probar, cargar modelos, quitar).
 * La clave se borra del campo en cuanto se guarda: la pantalla nunca la vuelve a mostrar.
 */
export function EngineCard(p: EngineCardProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(p.model);
  const [enabled, setEnabled] = useState(p.enabled);
  const [models, setModels] = useState<string[]>([]);
  const [result, setResult] = useState<EngineResult | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [, startTransition] = useTransition();

  const run = (kind: Exclude<Busy, null>, action: (data: FormData) => Promise<EngineResult>, after?: (r: EngineResult) => void) => {
    if (!formRef.current) return;
    const data = new FormData(formRef.current);
    setBusy(kind);
    startTransition(async () => {
      const r = await action(data);
      setResult(r);
      if (r.models) setModels(r.models);
      after?.(r);
      setBusy(null);
    });
  };

  const onSubmit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    run("save", saveEngine, (r) => r.ok && setApiKey(""));
  };

  const status = !p.hasKey ? (
    <Badge tone="warning">Sin clave</Badge>
  ) : p.enabled ? (
    <Badge tone="success">Activo</Badge>
  ) : (
    <Badge tone="neutral">Desactivado</Badge>
  );

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 id={`engine-${p.id}`} className="text-base font-semibold">
          {p.label}
        </h2>
        {status}
        {p.isDefault && p.hasKey && p.enabled && <Badge tone="primary">Por defecto</Badge>}
        {p.source === "env" && <Badge>Clave del archivo .env</Badge>}
      </div>

      <form ref={formRef} onSubmit={onSubmit} className="space-y-4" noValidate aria-labelledby={`engine-${p.id}`}>
        <input type="hidden" name="provider" value={p.id} />

        <Field
          label="Clave de API"
          htmlFor={`key-${p.id}`}
          hint={
            p.hasKey
              ? `Guardada${p.keyHint ? ` (termina en ${p.keyHint})` : ""}. Déjalo vacío para conservarla o pega una nueva para cambiarla.`
              : `Empieza por ${p.keyExample}`
          }
        >
          <Input
            id={`key-${p.id}`}
            name="apiKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(ev) => setApiKey(ev.target.value)}
            placeholder={p.hasKey ? `••••••••${p.keyHint ?? ""}` : p.keyExample}
          />
        </Field>
        <p className="-mt-2 text-xs text-muted">
          Créala en{" "}
          <a href={p.keyUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            {p.keyUrlLabel}
          </a>
          . Se guarda cifrada y no se vuelve a mostrar.
        </p>

        <Field label="Modelo" htmlFor={`model-${p.id}`} hint="Escribe el nombre o pulsa «Cargar modelos» para ver los que tiene tu cuenta (cambian cada pocos meses).">
          <div className="flex flex-wrap gap-2">
            <Input
              id={`model-${p.id}`}
              name="model"
              list={`models-${p.id}`}
              value={model}
              onChange={(ev) => setModel(ev.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1"
            />
            <datalist id={`models-${p.id}`}>
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => run("models", loadModels)}>
              {busy === "models" ? "Consultando…" : "Cargar modelos"}
            </Button>
          </div>
        </Field>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="enabled"
            checked={enabled}
            onChange={(ev) => setEnabled(ev.target.checked)}
            className="size-4 accent-[var(--primary)]"
          />
          Disponible para el equipo en el editor de publicaciones
        </label>

        {result && <Alert tone={result.ok ? "success" : "danger"}>{result.message}</Alert>}

        {p.lastTest && !result && (
          <p className={`text-xs ${p.lastTest.ok ? "text-muted" : "text-danger"}`}>
            Última prueba ({p.lastTest.at}): {p.lastTest.ok ? "conexión correcta." : (p.lastTest.error ?? "falló.")}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy !== null}>
            {busy === "save" ? "Guardando…" : "Guardar"}
          </Button>
          <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => run("test", testEngine)}>
            {busy === "test" ? "Probando…" : "Probar conexión"}
          </Button>
          {p.source === "db" && (
            <Button
              type="button"
              variant="danger"
              className="ml-auto"
              disabled={busy !== null}
              onClick={() => {
                if (!window.confirm(`¿Quitar la clave de ${p.label}? Dejará de estar disponible hasta que pegues otra.`)) return;
                run("remove", removeEngineKey, (r) => {
                  if (r.ok) {
                    setEnabled(false);
                    setApiKey("");
                  }
                });
              }}
            >
              {busy === "remove" ? "Quitando…" : "Quitar clave"}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
