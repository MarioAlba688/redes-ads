import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Badge, Card, PageHeader, buttonClass } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { dateTimeFormat } from "@/lib/display-time";
import { db } from "@/lib/db";
import { googleConfig } from "@/lib/google/config";
import { metaConfig } from "@/lib/meta/config";
import { missingAdsWriteScope, missingPublishScope } from "@/lib/meta/scopes";
import { can } from "@/lib/permissions";
import {
  ACCOUNT_KIND_LABELS,
  CONNECTION_STATUS_LABELS,
  isAdsPlatform,
  PLATFORMS,
  PLATFORM_NAMES,
  type PlatformId,
} from "@/lib/platforms";
import { tiktokConfig } from "@/lib/tiktok/config";
import { AccountRowActions, SyncAllButton } from "./account-controls";
import { DailyCapForm } from "./daily-cap-form";

export const metadata: Metadata = { title: "Cuentas" };

const statusTone = {
  ACTIVE: "success",
  EXPIRED: "warning",
  ERROR: "danger",
  REVOKED: "neutral",
} as const;

/** Dias que faltan para una fecha (negativo si ya paso); null si no hay fecha. */
function daysUntil(date: Date | null): number | null {
  return date ? Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : null;
}

type Flash = { tone: "success" | "warning" | "danger"; text: string };

type Query = Record<string, string | string[] | undefined>;

/** Mensaje que deja la conexion con Meta en la URL (?meta=...) al volver de Facebook. */
function metaFlash(q: Query): Flash | null {
  const get = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
  const ads = Number(get("ads")) || 0;
  const pages = Number(get("pages")) || 0;
  const ig = Number(get("ig")) || 0;
  const skipped = Number(get("skipped")) || 0;
  const skippedNote = skipped > 0 ? ` Atención: ${skipped} cuenta(s) no se pudieron guardar; el motivo está en la actividad reciente de Equipo.` : "";
  switch (get("meta")) {
    case "connected":
      if (ads + pages + ig === 0) {
        return {
          tone: "warning",
          text: "Meta aceptó la conexión pero no devolvió ninguna cuenta. Comprueba que tu usuario de Facebook es administrador de la página o de la cuenta publicitaria, y que la app de Meta tiene un rol asignado a tu usuario.",
        };
      }
      return {
        tone: skipped > 0 ? "warning" : "success",
        text: `Meta conectado: ${ads} cuenta(s) publicitaria(s), ${pages} página(s) de Facebook y ${ig} cuenta(s) de Instagram.${ads > 0 ? " Estoy descargando el rendimiento de los últimos 90 días; recarga en un momento." : ""}${skippedNote}`,
      };
    case "partial":
      return {
        tone: "warning",
        text: `Se conectó, pero no concediste el permiso "ads_read", así que no se pueden leer los anuncios. Vuelve a conectar y acepta todos los permisos. Se guardaron ${pages} página(s) y ${ig} cuenta(s) de Instagram.`,
      };
    case "denied":
      return { tone: "warning", text: "Cancelaste la conexión en Facebook. No se guardó nada." };
    case "bad_state":
      return { tone: "danger", text: "La conexión expiró o no es válida. Inténtalo de nuevo desde el botón Conectar." };
    case "not_configured":
      return {
        tone: "danger",
        text: "Meta no está configurado en este servidor: faltan META_APP_ID y META_APP_SECRET en el archivo .env.",
      };
    case "error":
      return {
        tone: "danger",
        text: "No se pudo completar la conexión con Meta. El detalle técnico está en la actividad reciente de Equipo (y en los registros del servidor). Si el motivo no es obvio, revisa que el ID, el secreto y la URL de retorno de la app sean correctos.",
      };
    default:
      return null;
  }
}

/** Mensaje que deja la conexion con Google Ads en la URL (?google=...) al volver de Google. */
function googleFlash(q: Query): Flash | null {
  const get = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
  const ads = Number(get("ads")) || 0;
  const skipped = Number(get("skipped")) || 0;
  switch (get("google")) {
    case "connected":
      if (ads === 0) {
        return {
          tone: "warning",
          text: "Google aceptó la conexión pero no devolvió ninguna cuenta de Google Ads. Comprueba que la cuenta de Google que elegiste tiene acceso a alguna cuenta de Google Ads activa.",
        };
      }
      return {
        tone: skipped > 0 ? "warning" : "success",
        text: `Google Ads conectado: ${ads} cuenta(s) publicitaria(s). Estoy descargando el rendimiento de los últimos 90 días; recarga en un momento.${skipped > 0 ? ` Atención: ${skipped} cuenta(s) no se pudieron leer; el motivo está en la actividad reciente de Equipo.` : ""}`,
      };
    case "denied":
      return { tone: "warning", text: "Cancelaste la conexión en Google. No se guardó nada." };
    case "bad_state":
      return { tone: "danger", text: "La conexión expiró o no es válida. Inténtalo de nuevo desde el botón Conectar Google Ads." };
    case "not_configured":
      return { tone: "danger", text: "Google Ads no está configurado en este servidor: faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el archivo .env." };
    case "no_refresh":
      return {
        tone: "danger",
        text: "Google no entregó el permiso de larga duración y la conexión habría durado solo una hora, así que no se guardó. Vuelve a conectar y acepta todos los permisos (si persiste, quita el acceso de la app en tu cuenta de Google → Seguridad → Conexiones de terceros y reinténtalo).",
      };
    case "not_approved":
      return {
        tone: "danger",
        text: "Tu proyecto de Google Cloud todavía no tiene acceso a la API de Google Ads con cuentas reales. Pídelo en Google Cloud Console → API de Google Ads (nivel Explorer o Básico) y vuelve a conectar.",
      };
    case "bad_client":
      return { tone: "danger", text: "Google rechazó el ID o el secreto de cliente de OAuth. Revisa GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el archivo .env." };
    case "error":
      return {
        tone: "danger",
        text: "No se pudo completar la conexión con Google Ads. El detalle técnico está en la actividad reciente de Equipo (y en los registros del servidor). Revisa que el ID de cliente, el secreto y la URI de redirección de OAuth sean correctos.",
      };
    default:
      return null;
  }
}

/** Mensaje que deja la conexion con TikTok Ads en la URL (?tiktok=...) al volver de TikTok. */
function tiktokFlash(q: Query): Flash | null {
  const get = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
  const ads = Number(get("ads")) || 0;
  const skipped = Number(get("skipped")) || 0;
  switch (get("tiktok")) {
    case "connected":
      if (ads === 0) {
        return { tone: "warning", text: "TikTok aceptó la conexión pero no devolvió ninguna cuenta publicitaria. Comprueba que autorizaste al menos un anunciante." };
      }
      return {
        tone: skipped > 0 ? "warning" : "success",
        text: `TikTok Ads conectado: ${ads} cuenta(s) publicitaria(s). Estoy descargando el rendimiento de los últimos 90 días; recarga en un momento.${skipped > 0 ? ` Atención: ${skipped} cuenta(s) no se pudieron leer; el motivo está en la actividad reciente de Equipo.` : ""}`,
      };
    case "denied":
      return { tone: "warning", text: "Cancelaste la autorización en TikTok. No se guardó nada." };
    case "bad_state":
      return { tone: "danger", text: "La conexión expiró o no es válida. Inténtalo de nuevo desde el botón Conectar TikTok." };
    case "not_configured":
      return { tone: "danger", text: "TikTok Ads no está configurado en este servidor: faltan TIKTOK_APP_ID y TIKTOK_APP_SECRET en el archivo .env." };
    case "error":
      return {
        tone: "danger",
        text: "No se pudo completar la conexión con TikTok Ads. El detalle técnico está en la actividad reciente de Equipo (y en los registros del servidor). Revisa que el ID de la app, el secreto y la URL de retorno coincidan con los de tu app de TikTok.",
      };
    default:
      return null;
  }
}

const connectFlash = (q: Query): Flash | null => metaFlash(q) ?? googleFlash(q) ?? tiktokFlash(q);

export default async function AccountsPage({ searchParams }: PageProps<"/cuentas">) {
  const user = await requireUser("accounts.view");
  const flash = connectFlash(await searchParams);

  // Solo columnas seguras: los tokens cifrados nunca salen de la base de datos hacia la pagina.
  const accounts = await db.socialAccount.findMany({
    select: {
      id: true,
      platform: true,
      kind: true,
      name: true,
      handle: true,
      status: true,
      currency: true,
      tokenExpiresAt: true,
      lastSyncedAt: true,
      lastError: true,
      scopes: true, // permisos concedidos por Meta (no es un secreto): sirve para avisar si falta el de publicar
      dailyBudgetCap: true, // tope de gasto diario por anuncio (cuentas publicitarias de Meta)
    },
    orderBy: [{ platform: "asc" }, { kind: "asc" }, { name: "asc" }],
  });

  const canManage = can(user.role, "accounts.manage");
  // Por plataforma: a donde manda el boton de conectar, si el servidor tiene las credenciales y que variables faltan.
  const CONNECT: Partial<Record<PlatformId, { href: string; ready: boolean; vars: [string, string]; where: string }>> = {
    META: { href: "/api/meta/connect", ready: metaConfig() !== null, vars: ["META_APP_ID", "META_APP_SECRET"], where: "Meta for Developers" },
    GOOGLE_ADS: { href: "/api/google/connect", ready: googleConfig() !== null, vars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], where: "Google Cloud Console" },
    TIKTOK: { href: "/api/tiktok/connect", ready: tiktokConfig() !== null, vars: ["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"], where: "TikTok for Business (Marketing API)" },
  };
  const hasAds = accounts.some((a) => isAdsPlatform(a.platform) && a.kind === "AD_ACCOUNT" && a.status !== "REVOKED");
  const dateFmt = dateTimeFormat();
  const dayFmt = dateTimeFormat({ time: false });

  return (
    <>
      <PageHeader
        title="Cuentas"
        description="Plataformas conectadas para anuncios y publicaciones."
        action={canManage && hasAds ? <SyncAllButton /> : undefined}
      />

      {flash && (
        <div className="mb-6">
          <Alert tone={flash.tone}>{flash.text}</Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {PLATFORMS.map((p) => {
          const count = accounts.filter((a) => a.platform === p.id && a.status !== "REVOKED").length;
          const connect = CONNECT[p.id];
          return (
            <Card key={p.id} className="flex flex-col gap-3 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">{p.name}</h2>
                  <p className="text-sm text-muted">{p.description}</p>
                </div>
                <Badge tone={count > 0 ? "success" : "neutral"}>
                  {count > 0 ? `${count} conectada${count === 1 ? "" : "s"}` : "Sin conectar"}
                </Badge>
              </div>

              {connect && canManage && connect.ready && (
                // Enlace normal (no <Link>): es una redireccion hacia la plataforma, no una pagina de la app.
                <a href={connect.href} className={`${buttonClass("primary")} mt-auto`}>
                  {count > 0 ? `Reconectar ${p.name}` : `Conectar ${p.name}`}
                </a>
              )}
              {p.id === "META" && (
                <Link href="/manual" className="-mt-1 text-xs font-medium text-primary hover:underline">
                  Guía paso a paso de Facebook e Instagram
                </Link>
              )}
              {connect && canManage && !connect.ready && (
                <p className="mt-auto rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted">
                  Falta crear la app en {connect.where} y poner <code>{connect.vars[0]}</code> y <code>{connect.vars[1]}</code> en{" "}
                  <code>.env</code>. Los pasos están en el README.
                </p>
              )}
              {connect && !canManage && (
                <p className="mt-auto text-xs text-muted">Solo un administrador puede conectar cuentas.</p>
              )}
              {!connect && (
                <button
                  type="button"
                  disabled
                  title={`La conexión con ${p.name} se habilita en la Fase ${p.phase}`}
                  className="mt-auto inline-flex cursor-not-allowed items-center justify-center rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted opacity-70"
                >
                  {`Disponible en la Fase ${p.phase}`}
                </button>
              )}
            </Card>
          );
        })}
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-semibold">Cuentas conectadas</h2>
        </div>
        {accounts.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">
            Todavía no hay cuentas conectadas. Aquí aparecerán tus páginas, perfiles y cuentas
            publicitarias cuando las conectes.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Cuenta</th>
                  <th className="px-5 py-2.5 font-medium">Tipo</th>
                  <th className="px-5 py-2.5 font-medium">Estado</th>
                  <th className="px-5 py-2.5 font-medium">Última sincronización</th>
                  {canManage && <th className="px-5 py-2.5" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {accounts.map((a) => {
                  const daysLeft = daysUntil(a.tokenExpiresAt);
                  const isAds = a.kind === "AD_ACCOUNT" && isAdsPlatform(a.platform);
                  return (
                    <tr key={a.id} className={a.status === "REVOKED" ? "opacity-60" : ""}>
                      <td className="px-5 py-3">
                        <p className="font-medium">{a.name}</p>
                        <p className="text-xs text-muted">
                          {[a.handle, a.currency].filter(Boolean).join(" · ") || PLATFORM_NAMES[a.platform]}
                        </p>
                        {a.platform === "META" && a.kind === "AD_ACCOUNT" && a.status !== "REVOKED" && (
                          <DailyCapForm accountId={a.id} currency={a.currency} cap={a.dailyBudgetCap === null ? null : Number(a.dailyBudgetCap)} canEdit={canManage} />
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <p>{ACCOUNT_KIND_LABELS[a.kind]}</p>
                        <p className="text-xs text-muted">{PLATFORM_NAMES[a.platform]}</p>
                      </td>
                      <td className="px-5 py-3">
                        <Badge tone={statusTone[a.status]}>{CONNECTION_STATUS_LABELS[a.status]}</Badge>
                        {a.status !== "REVOKED" && daysLeft !== null && (
                          <p className={`mt-1 text-xs ${daysLeft <= 7 ? "text-warning" : "text-muted"}`}>
                            {daysLeft > 0
                              ? `La conexión vence ${dayFmt.format(a.tokenExpiresAt!)} (${daysLeft} d)`
                              : "La conexión venció: reconecta Meta"}
                          </p>
                        )}
                        {a.lastError && a.status !== "REVOKED" && (
                          <p className="mt-1 max-w-xs text-xs text-danger">{a.lastError}</p>
                        )}
                        {a.status !== "REVOKED" && a.platform === "META" && a.kind === "AD_ACCOUNT" && missingAdsWriteScope(a.scopes) && (
                          <p className="mt-1 max-w-xs text-xs text-warning">
                            Sin permiso para crear anuncios (falta ads_management): solo se pueden ver sus cifras. Agrégalo en tu app de Meta y pulsa «Reconectar Meta».{" "}
                            <Link href="/manual#anuncios" className="font-medium underline">
                              Ver cómo
                            </Link>
                          </p>
                        )}
                        {a.status !== "REVOKED" && missingPublishScope(a.kind, a.scopes) && (
                          <p className="mt-1 max-w-xs text-xs text-warning">
                            Sin permiso para publicar (falta {missingPublishScope(a.kind, a.scopes)}). Agrégalo en tu app de Meta y pulsa «Reconectar Meta».{" "}
                            <Link href="/manual#permisos" className="font-medium underline">
                              Ver cómo
                            </Link>
                          </p>
                        )}
                      </td>
                      <td className="px-5 py-3 text-muted">
                        {a.lastSyncedAt ? dateFmt.format(a.lastSyncedAt) : "—"}
                      </td>
                      {canManage && (
                        <td className="px-5 py-3 text-right align-top">
                          {a.status !== "REVOKED" && (
                            <AccountRowActions
                              accountId={a.id}
                              canSync={isAds}
                              canDisconnect={isAdsPlatform(a.platform)}
                            />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
