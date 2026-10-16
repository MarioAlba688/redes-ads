import "server-only";
import { graphGet, graphGetAll } from "@/lib/meta/graph";
import { MetaApiError } from "@/lib/meta/errors";

export type MetaAdAccount = {
  /** Id numerico, sin el prefijo "act_". */
  id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  /** 1 = activa, 2 = deshabilitada, 3 = con pago pendiente, 101 = cerrada... */
  accountStatus: number | null;
};

export type MetaPage = {
  id: string;
  name: string;
  /** Token de la pagina (no vence mientras el token de la persona sea valido). */
  accessToken: string | null;
  instagram: { id: string; username: string | null; name: string | null } | null;
};

export type MetaAssets = {
  user: { id: string; name: string };
  grantedScopes: string[];
  declinedScopes: string[];
  adAccounts: MetaAdAccount[];
  pages: MetaPage[];
};

type RawAdAccount = {
  account_id: string;
  name?: string;
  currency?: string;
  timezone_name?: string;
  account_status?: number;
};

type RawPage = {
  id: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string; name?: string };
};

const PAGE_FIELDS = "id,name,access_token";
const PAGE_FIELDS_WITH_IG = `${PAGE_FIELDS},instagram_business_account{id,username,name}`;

/**
 * Consulta que puede ver la persona que conecto: sus permisos concedidos, sus cuentas
 * publicitarias, sus paginas de Facebook y las cuentas de Instagram vinculadas.
 * Si falta un permiso, esa lista queda vacia en lugar de fallar toda la conexion.
 */
export async function discoverAssets(userToken: string): Promise<MetaAssets> {
  const me = await graphGet<{ id: string; name?: string }>("me", {
    token: userToken,
    params: { fields: "id,name" },
  });

  const perms = await graphGetAll<{ permission: string; status: string }>("me/permissions", {
    token: userToken,
  });
  const grantedScopes = perms.filter((p) => p.status === "granted").map((p) => p.permission);
  const declinedScopes = perms.filter((p) => p.status === "declined").map((p) => p.permission);

  const adAccounts = await optionalList<RawAdAccount>(() =>
    graphGetAll<RawAdAccount>("me/adaccounts", {
      token: userToken,
      params: { fields: "account_id,name,currency,timezone_name,account_status" },
    }),
  );

  let pages = await optionalList<RawPage>(() =>
    graphGetAll<RawPage>("me/accounts", { token: userToken, params: { fields: PAGE_FIELDS_WITH_IG } }),
  );
  if (pages === null) {
    // Sin permiso de Instagram, pedir el campo anidado puede fallar: reintentamos solo con la pagina.
    pages = await optionalList<RawPage>(() =>
      graphGetAll<RawPage>("me/accounts", { token: userToken, params: { fields: PAGE_FIELDS } }),
    );
  }

  return {
    user: { id: me.id, name: me.name ?? "Cuenta de Facebook" },
    grantedScopes,
    declinedScopes,
    adAccounts: (adAccounts ?? []).map((a) => ({
      id: a.account_id,
      name: a.name || `Cuenta ${a.account_id}`,
      currency: a.currency ?? null,
      timezone: a.timezone_name ?? null,
      accountStatus: a.account_status ?? null,
    })),
    pages: (pages ?? []).map((p) => ({
      id: p.id,
      name: p.name || `Página ${p.id}`,
      accessToken: p.access_token ?? null,
      instagram: p.instagram_business_account
        ? {
            id: p.instagram_business_account.id,
            username: p.instagram_business_account.username ?? null,
            name: p.instagram_business_account.name ?? null,
          }
        : null,
    })),
  };
}

/** Ejecuta la consulta; si Meta la rechaza por permisos devuelve null, otros errores se propagan. */
async function optionalList<T>(fn: () => Promise<T[]>): Promise<T[] | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MetaApiError && (e.isPermissionError || e.code === 100)) return null;
    throw e;
  }
}
