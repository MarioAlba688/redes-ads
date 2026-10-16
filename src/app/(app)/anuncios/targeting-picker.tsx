"use client";

import { useEffect, useRef, useState } from "react";
import { Input, Select } from "@/components/ui";
import {
  AGE_MAX,
  AGE_MIN,
  CITY_RADIUS_DEFAULT_KM,
  CITY_RADIUS_MAX_KM,
  CITY_RADIUS_MIN_KM,
  COUNTRIES,
  MAX_INTERESTS,
} from "@/lib/promotions/targeting";
import type { Targeting } from "@/lib/promotions/types";

type InterestHit = { id: string; name: string; path: string | null };
type CityHit = { key: string; name: string; region: string | null; countryCode: string };

/** Busca en Meta (a traves de /api/ads/search) lo que se va escribiendo y deja elegir un resultado. */
function SearchBox<T extends InterestHit | CityHit>({
  type,
  accountId,
  placeholder,
  label,
  onPick,
  render,
  disabled,
}: {
  type: "interest" | "city";
  accountId: string | null;
  placeholder: string;
  label: string;
  onPick: (hit: T) => void;
  render: (hit: T) => string;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<T[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2 || !accountId) {
      // Nada que buscar: se limpian los resultados en el siguiente turno para no pisar el estado durante el render.
      const t = setTimeout(() => {
        setHits([]);
        setState("idle");
        setMessage(null);
      }, 0);
      return () => clearTimeout(t);
    }
    const mine = ++seq.current;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState("loading");
      try {
        const res = await fetch(`/api/ads/search?type=${type}&q=${encodeURIComponent(text)}&account=${encodeURIComponent(accountId)}`, { signal: controller.signal });
        const body = (await res.json().catch(() => ({}))) as { results?: T[]; error?: string };
        if (mine !== seq.current) return;
        if (!res.ok || body.error) {
          setHits([]);
          setState("error");
          setMessage(body.error ?? "No se pudo buscar.");
        } else {
          setHits(body.results ?? []);
          setState("idle");
          setMessage((body.results ?? []).length === 0 ? "Sin resultados." : null);
        }
      } catch {
        if (mine === seq.current && !controller.signal.aborted) {
          setHits([]);
          setState("error");
          setMessage("No se pudo buscar.");
        }
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, type, accountId]);

  return (
    <div className="relative">
      <Input
        type="search"
        aria-label={label}
        placeholder={accountId ? placeholder : "Elige primero la cuenta publicitaria"}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        disabled={disabled || !accountId}
        autoComplete="off"
      />
      {(hits.length > 0 || message || state === "loading") && (
        <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-surface text-sm shadow-lg">
          {state === "loading" && <li className="px-3 py-2 text-muted">Buscando…</li>}
          {message && state !== "loading" && <li className={`px-3 py-2 ${state === "error" ? "text-danger" : "text-muted"}`}>{message}</li>}
          {hits.map((h, i) => (
            <li key={`${i}-${"id" in h ? h.id : h.key}`}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left hover:bg-background"
                onClick={() => {
                  onPick(h);
                  setQ("");
                  setHits([]);
                  setMessage(null);
                }}
              >
                {render(h)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const chip = "inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs";

/** A quien se le muestra el anuncio: paises, ciudades, edad, genero e intereses. */
export function TargetingPicker({ value, onChange, accountId, disabled }: { value: Targeting; onChange: (t: Targeting) => void; accountId: string | null; disabled?: boolean }) {
  const set = (patch: Partial<Targeting>) => onChange({ ...value, ...patch });
  const toggleCountry = (code: string) =>
    set({ countries: value.countries.includes(code) ? value.countries.filter((c) => c !== code) : [...value.countries, code] });

  return (
    <div className="space-y-5">
      <fieldset disabled={disabled}>
        <legend className="mb-1.5 text-sm font-medium">Países</legend>
        <div className="flex flex-wrap gap-1.5">
          {COUNTRIES.map((c) => {
            const on = value.countries.includes(c.code);
            return (
              <button
                key={c.code}
                type="button"
                aria-pressed={on}
                onClick={() => toggleCountry(c.code)}
                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${on ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border text-muted hover:text-foreground"}`}
              >
                {c.name}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div>
        <p className="mb-1.5 text-sm font-medium">Ciudades <span className="font-normal text-muted">(opcional, con un radio alrededor)</span></p>
        <SearchBox<CityHit>
          type="city"
          accountId={accountId}
          label="Buscar una ciudad"
          placeholder="Busca una ciudad (por ejemplo Bogotá)"
          disabled={disabled}
          render={(h) => `${h.name}${h.region ? `, ${h.region}` : ""} (${h.countryCode})`}
          onPick={(h) => {
            if (value.cities.some((c) => c.key === h.key)) return;
            set({ cities: [...value.cities, { key: h.key, name: h.name, countryCode: h.countryCode, radiusKm: CITY_RADIUS_DEFAULT_KM }] });
          }}
        />
        {value.cities.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {value.cities.map((c) => (
              <li key={c.key} className="flex flex-wrap items-center gap-2 text-sm">
                <span className={chip}>{c.name} <span className="text-muted">({c.countryCode})</span></span>
                <label className="flex items-center gap-1 text-xs text-muted">
                  radio
                  <Input
                    type="number"
                    min={CITY_RADIUS_MIN_KM}
                    max={CITY_RADIUS_MAX_KM}
                    value={c.radiusKm}
                    disabled={disabled}
                    onChange={(e) => set({ cities: value.cities.map((x) => (x.key === c.key ? { ...x, radiusKm: Number(e.target.value) } : x)) })}
                    className="w-20 py-1 text-xs"
                    aria-label={`Radio de ${c.name} en kilómetros`}
                  />
                  km
                </label>
                <button type="button" className="text-xs text-danger hover:underline" disabled={disabled} onClick={() => set({ cities: value.cities.filter((x) => x.key !== c.key) })}>
                  Quitar
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1.5 block font-medium">Edad mínima</span>
          <Input type="number" min={AGE_MIN} max={AGE_MAX} value={value.ageMin} disabled={disabled} onChange={(e) => set({ ageMin: Number(e.target.value) })} />
        </label>
        <label className="block text-sm">
          <span className="mb-1.5 block font-medium">Edad máxima</span>
          <Input type="number" min={AGE_MIN} max={AGE_MAX} value={value.ageMax} disabled={disabled} onChange={(e) => set({ ageMax: Number(e.target.value) })} />
          <span className="mt-1 block text-xs text-muted">{AGE_MAX} incluye a quienes tienen más.</span>
        </label>
        <label className="block text-sm">
          <span className="mb-1.5 block font-medium">Género</span>
          <Select value={value.gender} disabled={disabled} onChange={(e) => set({ gender: e.target.value as Targeting["gender"] })}>
            <option value="all">Todas las personas</option>
            <option value="women">Mujeres</option>
            <option value="men">Hombres</option>
          </Select>
        </label>
      </div>

      <div>
        <p className="mb-1.5 text-sm font-medium">
          Intereses <span className="font-normal text-muted">(opcional, hasta {MAX_INTERESTS}; acotan a quién se le muestra)</span>
        </p>
        <SearchBox<InterestHit>
          type="interest"
          accountId={accountId}
          label="Buscar un interés"
          placeholder="Busca un interés (por ejemplo belleza, viajes)"
          disabled={disabled || value.interests.length >= MAX_INTERESTS}
          render={(h) => (h.path ? `${h.name} — ${h.path}` : h.name)}
          onPick={(h) => {
            if (value.interests.some((i) => i.id === h.id)) return;
            set({ interests: [...value.interests, { id: h.id, name: h.name }] });
          }}
        />
        {value.interests.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {value.interests.map((i) => (
              <span key={i.id} className={chip}>
                {i.name}
                <button type="button" aria-label={`Quitar ${i.name}`} disabled={disabled} className="text-muted hover:text-danger" onClick={() => set({ interests: value.interests.filter((x) => x.id !== i.id) })}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
