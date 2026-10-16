import "server-only";
import { adsRequest, CUSTOMER_ID_RE, searchStream, type AdsAuth } from "@/lib/google/client";
import { GoogleApiError } from "@/lib/google/errors";

export type GoogleCustomer = {
  /** ID de cliente de Google Ads, sin guiones. */
  id: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  /** Cuenta administradora (MCC) a traves de la cual se consulta; null si el acceso es directo. */
  loginCustomerId: string | null;
};

export type GoogleAssets = {
  accounts: GoogleCustomer[];
  /** Cuentas accesibles que no se pudieron leer, con el motivo (una cuenta con problemas no tumba a las demas). */
  skipped: { id: string; reason: string }[];
};

type CustomerRow = {
  customer?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean; status?: string };
  customerClient?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; manager?: boolean; status?: string };
};

const MAX_ACCESSIBLE = 50;
const MAX_ACCOUNTS = 300;
const CONCURRENCY = 4;

const ME_QUERY = "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1";
const CHILDREN_QUERY =
  "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.status = 'ENABLED'";

const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

/**
 * Cuentas de Google Ads a las que tiene acceso la persona: las directas y, si alguna es administradora (MCC), las
 * cuentas cliente que cuelgan de ella. Las administradoras en si no se guardan (no tienen anuncios propios).
 */
export async function discoverCustomers(accessToken: string): Promise<GoogleAssets> {
  const list = await adsRequest<{ resourceNames?: string[] }>("customers:listAccessibleCustomers", { accessToken });
  const ids = (list.resourceNames ?? [])
    .map((r) => r.replace(/^customers\//, ""))
    .filter((id) => CUSTOMER_ID_RE.test(id))
    .slice(0, MAX_ACCESSIBLE);

  const found = new Map<string, GoogleCustomer>();
  const skipped: GoogleAssets["skipped"] = [];

  const inspect = async (id: string) => {
    const auth: AdsAuth = { accessToken };
    try {
      const [row] = await searchStream<CustomerRow>(id, ME_QUERY, auth);
      const me = row?.customer;
      if (!me) return;
      if (me.manager) {
        // Administradora: se listan sus cuentas cliente, consultadas a traves de ella.
        const children = await searchStream<CustomerRow>(id, CHILDREN_QUERY, { accessToken, loginCustomerId: id });
        for (const c of children) {
          const k = c.customerClient;
          if (!k?.id || k.manager || !CUSTOMER_ID_RE.test(k.id)) continue;
          if (!found.has(k.id)) {
            found.set(k.id, { id: k.id, name: clean(k.descriptiveName) ?? `Cuenta ${k.id}`, currency: clean(k.currencyCode), timezone: clean(k.timeZone), loginCustomerId: id });
          }
        }
      } else if (me.status === "ENABLED") {
        // El acceso directo manda sobre el que pasa por una administradora.
        found.set(id, { id, name: clean(me.descriptiveName) ?? `Cuenta ${id}`, currency: clean(me.currencyCode), timezone: clean(me.timeZone), loginCustomerId: null });
      }
    } catch (e) {
      // Un token vencido afecta a todas: se propaga. Lo demas (cuenta cancelada, sin permiso) solo salta esa cuenta.
      if (e instanceof GoogleApiError && (e.isAuthError || e.network || e.isProjectNotApproved || e.isBadClient)) throw e;
      skipped.push({ id, reason: e instanceof GoogleApiError ? e.userMessage : "Error inesperado." });
    }
  };

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    await Promise.all(ids.slice(i, i + CONCURRENCY).map(inspect));
  }
  return { accounts: [...found.values()].slice(0, MAX_ACCOUNTS), skipped };
}
