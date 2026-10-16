import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { imageExists } from "@/lib/media";
import { META_SCOPES } from "@/lib/meta/config";
import { buildMetaDiagnostics, isLocalHost, type CheckStatus } from "@/lib/meta/diagnostics";
import { can } from "@/lib/permissions";
import { Callout, Code, Ext, Problem, Section, Step, Steps, UI } from "./parts";

export const metadata: Metadata = { title: "Manual" };

/** Permisos con los que funciona todo: anuncios, paginas, publicar en Facebook y en Instagram, y leer sus estadisticas. */
const RECOMMENDED_SCOPES =
  "ads_read,ads_management,business_management,pages_show_list,pages_read_engagement,pages_read_user_content,pages_manage_posts,read_insights,instagram_basic,instagram_content_publish,instagram_manage_insights";

const TOC = [
  { id: "requisitos", label: "Antes de empezar" },
  { id: "instagram", label: "1. La cuenta de Instagram" },
  { id: "crear-app", label: "2. La app en Meta for Developers" },
  { id: "servidor", label: "3. El servidor (.env)" },
  { id: "conectar", label: "4. Conectar en la app" },
  { id: "marcas", label: "5. Asignar a cada marca" },
  { id: "publicar-instagram", label: "6. Publicar en Instagram" },
  { id: "estadisticas", label: "7. Estadísticas de las publicaciones" },
  { id: "anuncios", label: "8. Anuncios" },
  { id: "permisos", label: "Si falta el permiso de publicar" },
  { id: "problemas", label: "Mensajes frecuentes" },
];

const STATUS: Record<CheckStatus, { icon: string; label: string; tone: "success" | "warning" | "neutral" }> = {
  ok: { icon: "✓", label: "Listo", tone: "success" },
  warn: { icon: "!", label: "Revisar", tone: "warning" },
  todo: { icon: "○", label: "Pendiente", tone: "neutral" },
};

/** Cuantas de las ultimas imagenes registradas en la base tienen su archivo en la carpeta de medios de este servidor. */
async function mediaFilesStatus(): Promise<{ total: number; missing: number }> {
  const rows = await db.postMedia.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { storageKey: true } });
  const present = await Promise.all(rows.map((r) => imageExists(r.storageKey)));
  return { total: rows.length, missing: present.filter((p) => !p).length };
}

export default async function ManualPage() {
  const user = await requireUser();
  const e = env();
  const appUrl = e.APP_URL.replace(/\/$/, "");
  const redirectUri = `${appUrl}/api/meta/callback`;
  // Lo que va en «Dominios de la app» de Meta: solo el dominio, sin https:// ni puerto ni ruta.
  const appHost = new URL(appUrl).hostname;
  // El tunel apunta al puerto en el que corre la app en este PC (el de APP_URL si es local; si no, el de `npm run dev`).
  const localAddress = isLocalHost(new URL(appUrl).hostname) ? appUrl : "http://localhost:3000";
  const scopes = e.META_SCOPES ? e.META_SCOPES.split(",").map((s) => s.trim()).filter(Boolean) : [...META_SCOPES];

  // El diagnostico muestra la configuracion del servidor: solo para quien administra las cuentas (no incluye secretos).
  // Las imagenes se guardan en disco (MEDIA_DIR) y la base de datos puede ser compartida con otra copia de la app:
  // se cuenta cuantas de las ultimas imagenes registradas faltan en ESTE servidor.
  const media = can(user.role, "accounts.manage") ? await mediaFilesStatus() : undefined;
  const diagnostics = can(user.role, "accounts.manage")
    ? buildMetaDiagnostics({
        media,
        configured: !!(e.META_APP_ID && e.META_APP_SECRET),
        scopes,
        appUrl,
        mediaBaseUrl: e.MEDIA_PUBLIC_BASE_URL ?? null,
        accounts: (
          await db.socialAccount.findMany({
            where: { platform: "META", status: { not: "REVOKED" } },
            select: { kind: true, name: true, scopes: true, dailyBudgetCap: true },
            orderBy: { name: "asc" },
          })
        ).map((a) => ({ ...a, dailyBudgetCap: a.dailyBudgetCap === null ? null : Number(a.dailyBudgetCap) })),
      })
    : null;
  const pending = diagnostics?.filter((c) => c.status !== "ok").length ?? 0;

  return (
    <>
      <PageHeader
        title="Manual: Facebook e Instagram"
        description="Cómo dejar conectadas tus páginas y cuentas de Instagram para publicar desde aquí y ver cómo les va, paso a paso y con los problemas que más se ven."
      />

      <div className="space-y-6">
        {diagnostics && (
          <section aria-labelledby="estado-titulo" className="scroll-mt-6">
          <Card className="p-5 md:p-6">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="estado-titulo" className="text-lg font-semibold tracking-tight">
                Tu estado ahora
              </h2>
              <Badge tone={pending === 0 ? "success" : "warning"}>{pending === 0 ? "Todo en orden" : `${pending} por revisar`}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted">Lo que esta app ve de tu configuración. Si algo no está en orden, el enlace te lleva al paso que lo arregla.</p>
            <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
              {diagnostics.map((c) => {
                const s = STATUS[c.status];
                return (
                  <li key={c.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                        c.status === "ok" ? "bg-success-bg text-success" : c.status === "warn" ? "bg-warning-bg text-warning" : "border border-border text-muted"
                      }`}
                    >
                      {s.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium [overflow-wrap:anywhere]">
                        {c.title} <span className="sr-only">({s.label})</span>
                      </p>
                      {/* anywhere: un nombre de cuenta muy largo y sin espacios no debe ensanchar la pagina en el movil */}
                      <p className="mt-0.5 text-muted [overflow-wrap:anywhere]">{c.detail}</p>
                    </div>
                    {c.status !== "ok" && c.anchor && (
                      <a href={`#${c.anchor}`} className="shrink-0 text-xs font-medium text-primary hover:underline">
                        Ver el paso
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
          </section>
        )}

        <Card className="p-5">
          <nav aria-label="En esta guía">
            <h2 className="mb-2 text-sm font-semibold">En esta guía</h2>
            <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {TOC.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`} className="text-primary hover:underline">
                    {t.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </Card>

        <Section id="requisitos" title="Antes de empezar" intro="Lo que necesitas tener a mano. Si algo no lo tienes, los pasos de abajo te dicen cómo conseguirlo.">
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
            <li>Tu usuario de Facebook como <UI>administrador con control total</UI> de la página de cada marca.</li>
            <li>
              Para Instagram: una cuenta <UI>profesional</UI> (Empresa) de Instagram <UI>vinculada a esa página</UI>.
            </li>
            <li>
              Recomendado: las páginas, las cuentas de Instagram y las cuentas publicitarias dentro de un <UI>portafolio comercial</UI> de Meta (
              <Ext href="https://business.facebook.com/settings">business.facebook.com/settings</Ext>).
            </li>
            <li>
              Un usuario con rol <UI>Administrador</UI> en esta app: es el único que conecta cuentas.
            </li>
          </ul>
          <Callout title="Facebook e Instagram no publican igual">
            <p>
              En <UI>Facebook</UI> la app sube la imagen directamente, así que funciona aunque la app esté en tu computador. En <UI>Instagram</UI> es Meta quien
              <em> descarga</em> la imagen desde internet: la app necesita una dirección pública con HTTPS (paso 6).
            </p>
          </Callout>
        </Section>

        <Section id="instagram" title="1. La cuenta de Instagram" intro="Si ya tienes una cuenta profesional vinculada a tu página y agregada a tu portafolio, salta al paso 2.">
          <Steps>
            <Step>
              Crea la cuenta (en la app del celular o en instagram.com) con un <UI>correo del negocio</UI>, no uno personal: ese correo la recupera. Activa la verificación en dos pasos en{" "}
              <UI>Configuración → Centro de cuentas → Contraseña y seguridad</UI>.
            </Step>
            <Step>
              Conviértela en profesional: <UI>Configuración y privacidad → Tipo de cuenta y herramientas → Cambiar a cuenta profesional → Empresa</UI>, y elige la categoría. Una cuenta personal no puede publicar
              desde una app.
            </Step>
            <Step>
              Vincúlala a la página: en Instagram, <UI>Editar perfil → Información pública de la empresa → Página</UI>. También puedes hacerlo desde Facebook en la página: <UI>Configuración → Cuentas vinculadas → Instagram → Conectar</UI>.
              Usa el mismo usuario de Facebook que administra la página. En el perfil debe verse «Página: …».
            </Step>
            <Step>
              Agrégala al portafolio: <Ext href="https://business.facebook.com/settings">business.facebook.com/settings</Ext> → <UI>Cuentas → Cuentas de Instagram → Agregar</UI> e inicia sesión con la cuenta. Luego
              haz clic en ella → <UI>Asignar personas</UI> → tu usuario con <UI>Control total</UI>.
            </Step>
            <Step>
              Comprueba el vínculo: en <UI>Cuentas → Páginas</UI> abre tu página y debe aparecer la cuenta de Instagram. Si no aparece, la app no la encontrará al conectar.
            </Step>
          </Steps>
        </Section>

        <Section id="crear-app" title="2. La app en Meta for Developers" intro="Es la «llave» con la que esta aplicación habla con Facebook e Instagram. Es gratis y no se publica en ninguna tienda.">
          <Steps>
            <Step>
              Entra a <Ext href="https://developers.facebook.com/apps">developers.facebook.com/apps</Ext> → <UI>Crear app</UI> y vincúlala a tu portafolio comercial.
            </Step>
            <Step>
              En el menú izquierdo: <UI>Casos de uso → Agregar casos de uso</UI>. Filtra por <UI>Administración de contenido</UI> y marca:
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>
                  <UI>Administrar todos los aspectos de tu página</UI>: da el permiso para publicar en Facebook (<code>pages_manage_posts</code>).
                </li>
                <li>
                  <UI>Administrar mensajes y contenido en Instagram</UI>: para Instagram.
                </li>
                <li>
                  Para ver y crear anuncios, el caso de uso de la <UI>API de marketing</UI> (<code>ads_read</code> y <code>ads_management</code>). Los de Threads, video en vivo, oEmbed o eventos no hacen falta.
                </li>
              </ul>
              Pulsa <UI>Guardar</UI>.
            </Step>
            <Step>
              <UI>Importante para Instagram:</UI> abre ese caso de uso (<UI>Personalizar</UI>). Por defecto muestra la configuración «con inicio de sesión de Instagram» (permisos <code>instagram_business_…</code>), que esta app{" "}
              <UI>no</UI> usa. Pulsa el enlace <UI>API setup with Facebook login</UI> y luego <UI>Add required content permissions</UI> (el de contenido, <UI>no</UI> el de mensajes). Así se agregan <code>instagram_basic</code> e{" "}
              <code>instagram_content_publish</code>, además de <code>pages_read_engagement</code>, <code>business_management</code> y <code>pages_show_list</code>.
              <div className="mt-2">
                <Callout tone="warning">
                  Revisa en <UI>Permisos y funciones</UI> el nombre exacto de cada permiso tal como lo muestra Meta y úsalo igual en <code>META_SCOPES</code>. Si Facebook responde <em>«Invalid Scopes»</em> al conectar, es que
                  algún permiso de la lista no está habilitado en tu app (ver «Mensajes frecuentes»).
                </Callout>
              </div>
            </Step>
            <Step>
              En <UI>Inicio de sesión de Facebook → Configuración</UI>, en <UI>URI de redireccionamiento de OAuth válidos</UI>, pega exactamente esta dirección (tiene que coincidir letra por letra):
              <Code text={redirectUri} />
              <p className="mt-2 text-muted">
                Meta exige HTTPS salvo en <code>localhost</code>. Cuando la app esté en tu servidor con dominio, agrega también <code>https://TU-DOMINIO/api/meta/callback</code>.
              </p>
            </Step>
            <Step>
              En <UI>Configuración de la app → Básica</UI>, en <UI>Dominios de la app</UI>, agrega el dominio con el que abres esta app, <UI>sin</UI> <code>https://</code> ni nada después del dominio (si usas la app en tu PC y en tu servidor, agrega los dos) y pulsa{" "}
              <UI>Guardar cambios</UI>. Ahora mismo sería:
              <Code text={appHost} />
              <p className="mt-2 text-muted">Sin esto, Facebook responde «No se puede cargar la URL» al intentar conectar (ver «Mensajes frecuentes»).</p>
            </Step>
            <Step>
              <UI>Modo desarrollo:</UI> mientras la app esté en ese modo funciona sin revisión de Meta para las personas con un <UI>rol en la app</UI> (<UI>Roles de la app</UI>: administradores, desarrolladores o probadores). Asegúrate de que tu
              usuario esté ahí. No pulses «Crear configuración» en <UI>Facebook Login for Business</UI>: no hace falta.
            </Step>
            <Step>
              En <UI>Configuración de la app → Básica</UI> copia el <UI>ID de la app</UI> y la <UI>clave secreta</UI> (la clave secreta no se comparte con nadie ni se sube a ningún repositorio).
            </Step>
          </Steps>
        </Section>

        <Section id="servidor" title="3. El servidor (.env)" intro="El archivo .env está en la carpeta del proyecto (en el servidor, el .env del servidor). Después de cambiarlo hay que reiniciar la app.">
          <Steps>
            <Step>
              Pon el ID y la clave secreta del paso 2:
              <Code text={'META_APP_ID="el-id-de-tu-app"\nMETA_APP_SECRET="la-clave-secreta"'} />
            </Step>
            <Step>
              Pon los permisos que se piden al conectar. Esta línea sirve para anuncios, Facebook e Instagram (quita los de Instagram si todavía no los habilitaste en tu app):
              <Code text={`META_SCOPES="${RECOMMENDED_SCOPES}"`} />
            </Step>
            <Step>
              Comprueba que <code>APP_URL</code> es la dirección con la que abres la app (<code>{appUrl}</code> ahora). Es la que Meta usa para devolverte a la app al conectar: no la cambies por la de un túnel.
            </Step>
            <Step>Reinicia la app para que lea los cambios.</Step>
          </Steps>
          <Callout tone="warning" title="Solo permisos que tu app de Meta tiene habilitados">
            Si pones en <code>META_SCOPES</code> un permiso que la app no tiene, Facebook corta la conexión con <em>«Invalid Scopes: …»</em> y nombra los que sobran. Quítalos de la lista (o habilítalos en la app) y vuelve a conectar.
          </Callout>
        </Section>

        <Section id="conectar" title="4. Conectar en la app" intro="Solo el Administrador ve el botón.">
          <Steps>
            <Step>
              Ve a <Link href="/cuentas" className="font-medium text-primary hover:underline">Cuentas</Link> y pulsa <UI>Conectar Meta</UI> (si ya conectaste antes, <UI>Reconectar Meta</UI>).
            </Step>
            <Step>
              En la pantalla de Facebook acepta <UI>todos</UI> los permisos y <UI>marca las páginas y la cuenta de Instagram</UI> que quieres usar. Lo que no marques, la app no lo ve.
            </Step>
            <Step>
              Al volver verás el resumen («N cuenta(s) publicitaria(s), N página(s) de Facebook y N cuenta(s) de Instagram»). En la tabla, cada página dice si le falta el permiso de publicar.
            </Step>
            <Step>
              Reconecta cada vez que cambies permisos en Meta o <code>META_SCOPES</code>, y antes de que venza la conexión (dura unos 60 días; la tabla muestra la fecha).
            </Step>
          </Steps>
        </Section>

        <Section id="marcas" title="5. Asignar las cuentas a cada marca">
          <Steps>
            <Step>
              Ve a <Link href="/marcas" className="font-medium text-primary hover:underline">Marcas</Link>, abre la marca (o créala) y marca <UI>su página de Facebook y su cuenta de Instagram</UI>. Cada cuenta pertenece a una sola marca.
            </Step>
            <Step>
              En <Link href="/publicaciones/nueva" className="font-medium text-primary hover:underline">Publicaciones → Nueva publicación</Link> esas cuentas aparecen como destinos de la marca.
            </Step>
          </Steps>
        </Section>

        <Section id="publicar-instagram" title="6. Publicar en Instagram: imagen y dirección pública">
          <h3 className="text-sm font-semibold">La imagen</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
            <li>Instagram exige una imagen (una por publicación).</li>
            <li>
              Formato <UI>JPG</UI>: si subes un PNG, la app lo convierte sola al subirlo.
            </li>
            <li>Proporción entre <UI>4:5</UI> (vertical) y <UI>1,91:1</UI> (horizontal), al menos 320 píxeles de ancho y hasta 8 MB.</li>
          </ul>
          <h3 className="pt-2 text-sm font-semibold">La dirección pública</h3>
          <p className="text-sm leading-relaxed">Meta descarga la imagen desde internet, así que la app tiene que ser accesible con HTTPS. Tienes dos caminos:</p>
          <div className="space-y-4">
            <div className="rounded-lg border border-border p-4 text-sm leading-relaxed">
              <p className="font-semibold">A. Servidor con dominio (recomendado)</p>
              <p className="mt-1 text-muted">Es lo definitivo: también publica a su hora sin que tu computador esté encendido.</p>
              <div className="mt-3">
                <Steps>
                  <Step>
                    Pon la app en tu VPS detrás de un dominio con HTTPS (un proxy como Caddy o Nginx con certificado).
                  </Step>
                  <Step>
                    En el <code>.env</code> del servidor, <code>APP_URL</code> es esa dirección (por ejemplo <code>https://redes.tu-dominio.com</code>, sin barra final). No hace falta <code>MEDIA_PUBLIC_BASE_URL</code>.
                  </Step>
                  <Step>
                    En tu app de Meta, agrega <code className="break-all">https://redes.tu-dominio.com/api/meta/callback</code> (con tu dominio) a las <UI>URI de redireccionamiento de OAuth válidos</UI> (paso 2) y reinicia la app.
                  </Step>
                </Steps>
              </div>
            </div>
            <div className="rounded-lg border border-border p-4 text-sm leading-relaxed">
              <p className="font-semibold">B. Túnel temporal (para probar)</p>
              <Steps>
                <Step>
                  Instala la herramienta una vez:
                  <Code text="winget install --id Cloudflare.cloudflared" />
                </Step>
                <Step>
                  Con la app corriendo, en otra terminal:
                  <Code text={`cloudflared tunnel --url ${localAddress}`} />
                  Imprime una dirección como <code>https://…-…-….trycloudflare.com</code>: es <UI>la tuya</UI>, cópiala completa.
                </Step>
                <Step>
                  Ponla en el <code>.env</code> (sin barra final) y reinicia. <UI>No cambies APP_URL.</UI>
                  <Code text={'MEDIA_PUBLIC_BASE_URL="https://TU-DIRECCION-REAL.trycloudflare.com"'} />
                </Step>
                <Step>
                  Comprueba abriendo esa dirección + <code>/login</code> en el navegador: debe verse la pantalla de inicio de sesión.
                </Step>
              </Steps>
              <p className="mt-2 text-muted">Mientras el túnel está abierto cualquiera con esa dirección ve tu pantalla de inicio de sesión. Ciérralo (Ctrl+C) al terminar; cada vez que lo abras la dirección cambia.</p>
            </div>
          </div>
          <Callout tone="warning">
            <p>
              <UI>Error típico:</UI> copiar la dirección de ejemplo de una guía en lugar de la que imprime tu túnel. Esa dirección no existe y Instagram responderá «no pudo descargar la imagen».
              {diagnostics && <> El recuadro «Tu estado ahora», arriba, avisa cuando detecta una dirección de ejemplo.</>}
            </p>
          </Callout>
        </Section>

        <Section id="estadisticas" title="7. Estadísticas de las publicaciones" intro="Vistas, alcance, reacciones, comentarios, compartidos y guardados de lo que publicas desde esta app. Se ven en el menú Estadísticas.">
          <Steps>
            <Step>
              En tu app de Meta, dentro de los mismos casos de uso del paso 2, comprueba en <UI>Permisos y funciones</UI> que aparecen <code>pages_read_engagement</code>, <code>pages_read_user_content</code> y <code>read_insights</code> (Facebook) e{" "}
              <code>instagram_basic</code> e <code>instagram_manage_insights</code> (Instagram). Si falta alguno, búscalo ahí por su nombre y pulsa <UI>Agregar</UI>. En modo desarrollo funcionan para quienes tienen un rol en la app; para usar la app con cuentas de otras personas
              Meta pide revisión.
            </Step>
            <Step>
              Agrégalos a <code>META_SCOPES</code> (paso 3), reinicia la app y pulsa <UI>Reconectar Meta</UI> en <Link href="/cuentas" className="font-medium text-primary hover:underline">Cuentas</Link>. Sin reconectar, la conexión guardada sigue sin los permisos nuevos.
            </Step>
            <Step>
              Nada más: la app lee las cifras sola, unos minutos después de publicar, y las vuelve a leer cada 3 horas los primeros 2 días, cada 12 horas hasta las 2 semanas y una vez al día hasta los 90 días. En{" "}
              <Link href="/estadisticas" className="font-medium text-primary hover:underline">Estadísticas</Link> el botón <UI>Actualizar</UI> las lee al momento.
            </Step>
          </Steps>
          <div className="grid gap-4 text-sm leading-relaxed md:grid-cols-2">
            <div className="rounded-lg border border-border p-4">
              <p className="font-semibold">Facebook</p>
              <p className="mt-1 text-muted">
                Compartidos (permiso <code>pages_read_engagement</code>). Reacciones y comentarios (permiso <code>pages_read_user_content</code>: son contenido de otras personas y Meta lo pide aparte). Vistas y alcance (permiso <code>read_insights</code>).
                Sin <code>pages_read_user_content</code> las reacciones se calculan de las estadísticas de cada publicación, pero los comentarios no se pueden leer.
              </p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="font-semibold">Instagram</p>
              <p className="mt-1 text-muted">
                «Me gusta» y comentarios (<code>instagram_basic</code>). Alcance, vistas, guardados y compartidos (<code>instagram_manage_insights</code>). Si la cuenta oculta los «me gusta», Instagram no los entrega y se ve «—».
              </p>
            </div>
          </div>
          <Callout tone="warning" title="Meta cambia sus métricas">
            <p>
              En 2025 Meta retiró las «impresiones» y puso «vistas» y «alcance», y los nombres siguen cambiando. Si una cifra desaparece, la app guarda las demás y avisa cuál faltó en esa publicación; no se pierde nada de lo ya leído.
            </p>
          </Callout>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
            <li>Solo se miden las publicaciones hechas <UI>desde esta app</UI>, no las que subas a mano a Facebook o Instagram.</li>
            <li>Las vistas y el alcance pueden tardar unas horas en aparecer. Hasta entonces se ve «—», que no es lo mismo que 0.</li>
            <li>Facebook e Instagram no miden igual: compáralas por separado.</li>
          </ul>
        </Section>

        <Section
          id="anuncios"
          title="8. Anuncios: crear, activar y controlar el gasto"
          intro="Desde Anuncios puedes impulsar publicaciones, armar anuncios nuevos y administrar las campañas de tu cuenta publicitaria. Crear anuncios gasta dinero de verdad: por eso todo nace en pausa y tiene un tope."
        >
          <Callout title="Cómo se protege el dinero">
            <ul className="list-disc space-y-1 pl-5">
              <li>
                Todo anuncio se crea <UI>en pausa</UI>: no gasta nada hasta que una persona con permiso de <UI>aprobar</UI> lo active. Quien lo crea (Editor) no puede activarlo.
              </li>
              <li>
                El administrador fija un <UI>tope de gasto diario por anuncio</UI> en cada cuenta publicitaria (en <Link href="/cuentas" className="font-medium text-primary hover:underline">Cuentas</Link>). Sin tope diario no se crea ni se activa nada, y ningún presupuesto puede pasarlo.
              </li>
              <li>Al activar, la app vuelve a leer el presupuesto que Meta tiene <em>en ese momento</em> y lo compara con el tope (alguien pudo cambiarlo en Meta).</li>
              <li>
                Además puede haber un <UI>tope mensual</UI> (opcional) por cuenta. Al activar, la app suma lo ya gastado en el mes, lo que otros anuncios activos todavía pueden gastar y lo que gastaría este, y si no cabe no lo activa. Y si el gasto del mes llega al tope, los anuncios activos creados desde la app se <UI>pausan solos</UI>.
              </li>
              <li>Después de crear, comprueba con Meta que quedó en pausa y con el presupuesto pedido. Si algo no cuadra, lo borra y te avisa; si falla a medias, también borra lo que alcanzó a crear.</li>
              <li>
                Los presupuestos se escriben en la moneda de la cuenta y se convierten con la tabla oficial de Meta (el peso colombiano no lleva decimales: 50.000 son cincuenta mil). Una moneda que no esté en esa tabla se rechaza.
              </li>
            </ul>
          </Callout>
          <Steps>
            <Step>
              <UI>Permiso en Meta.</UI> Crear y administrar anuncios necesita <code>ads_management</code> (ver anuncios solo pide <code>ads_read</code>). En tu app de Meta, caso de uso de la <UI>API de marketing</UI>, comprueba en <UI>Permisos y funciones</UI> que aparece, agrégalo a{" "}
              <code>META_SCOPES</code> (paso 3), reinicia y pulsa <UI>Reconectar Meta</UI>. Mientras la app esté en modo desarrollo funciona con tu usuario y tus cuentas; para usarla con cuentas de otras empresas Meta pide revisión.
            </Step>
            <Step>
              <UI>La cuenta publicitaria lista en Meta.</UI> Tiene que tener un <UI>método de pago</UI> válido y los términos aceptados (<Ext href="https://adsmanager.facebook.com">Administrador de anuncios</Ext>). Tu usuario debe tener acceso a la cuenta (administrador o anunciante) y la <UI>página</UI> de la marca tiene que estar asignada a esa cuenta publicitaria en el portafolio (
              <Ext href="https://business.facebook.com/settings">business.facebook.com/settings</Ext> → <UI>Cuentas → Páginas</UI> → <UI>Agregar socios</UI> / asignar la cuenta publicitaria). Para impulsar Instagram, la cuenta también debe estar en el portafolio y vinculada a esa página.
            </Step>
            <Step>
              <UI>El administrador fija los topes</UI> de cada cuenta en <Link href="/cuentas" className="font-medium text-primary hover:underline">Cuentas</Link>: el <UI>diario</UI> por anuncio es obligatorio (por ejemplo 50.000 COP al día) y el <UI>mensual</UI> es opcional pero recomendado (por ejemplo 1.000.000 COP): con él la app no deja activar lo que no quepa en el mes y pausa los anuncios activos si el gasto del mes lo alcanza.
            </Step>
            <Step>
              <UI>Crear.</UI> En <Link href="/anuncios/creados" className="font-medium text-primary hover:underline">Anuncios → Creados en la app</Link>: <UI>Impulsar una publicación</UI> (una que ya salió en Facebook o Instagram; también desde su ficha en Publicaciones) o <UI>Anuncio nuevo</UI> (usa el texto y la imagen de una publicación, con enlace y botón, sin publicarla en tu página). Eliges objetivo, presupuesto por día, duración (1 a 30 días) y a quién se le muestra: países, ciudades con radio, edad, género e intereses buscados en Meta.
            </Step>
            <Step>
              <UI>Aprobar y activar.</UI> Quien aprueba abre el anuncio y pulsa <UI>Activar anuncio</UI>: la app confirma cuánto puede gastar como máximo y la duración empieza a contar desde ese momento. Meta revisa el anuncio antes de mostrarlo; su estado («En revisión», «Rechazado»…) se ve en la ficha.
            </Step>
            <Step>
              <UI>Controlar.</UI> Desde la ficha: <UI>Pausar</UI> (también quien lo creó: pausar nunca gasta), <UI>cambiar el presupuesto</UI> (sin pasar del tope) y <UI>archivar</UI>. En <Link href="/anuncios/campanas" className="font-medium text-primary hover:underline">Campañas en Meta</Link> ves y administras lo que ya existe en la cuenta, también lo creado directamente en Meta: pausar, activar (si cabe en el tope) y cambiar el presupuesto diario.
            </Step>
          </Steps>
          <Callout title="Cómo configurar el medio de pago en Meta (una sola vez)">
            <p>
              El dinero de los anuncios sale del medio de pago de la <UI>cuenta publicitaria</UI>, no de esta app (que nunca guarda datos de pago). Se configura en Meta. Si algún nombre no coincide con lo que ves, busca «Facturación» o «Configuración de pagos»: Meta cambia sus pantallas seguido.
            </p>
            <Steps>
              <Step>
                Entra al <Ext href="https://adsmanager.facebook.com">Administrador de anuncios</Ext> y elige arriba a la izquierda <UI>la cuenta publicitaria correcta</UI>. Necesitas ser <UI>administrador</UI> de esa cuenta (o tener rol de finanzas): quien solo es anunciante no puede cambiar medios de pago.
              </Step>
              <Step>
                Abre <UI>Facturación y pagos</UI> (menú de la izquierda). Si no aparece: <Ext href="https://business.facebook.com/billing_hub">business.facebook.com/billing_hub</Ext>, o <UI>Configuración del negocio → Cuentas → Cuentas publicitarias</UI> → tu cuenta → <UI>Configuración de pagos</UI>.
              </Step>
              <Step>
                Pulsa <UI>Agregar método de pago</UI>. El país y la moneda son los de la cuenta; <UI>la moneda no se puede cambiar después</UI> (si necesitas otra, hay que crear otra cuenta publicitaria). Elige tarjeta de crédito o débito (o PayPal u otras opciones si tu país las ofrece) y completa los datos.
              </Step>
              <Step>
                Con tarjeta: pide a tu banco que permita <UI>compras en línea en el exterior</UI> (Meta cobra desde fuera del país y a veces en dólares); es la causa más común de pagos rechazados. Deja el método como <UI>principal</UI>.
              </Step>
              <Step>
                Elige cómo se cobra: <UI>cobro automático</UI> (se carga a tu tarjeta al llegar a un umbral de gasto que Meta fija, o en la fecha mensual) o, donde existe, <UI>saldo prepagado</UI> (agregas dinero y los anuncios gastan de ahí). El prepago es lo que mejor limita el gasto máximo.
              </Step>
              <Step>
                Como red de seguridad de Meta, independiente de esta app, fija el <UI>límite de gasto de la cuenta</UI> (<UI>Configuración de la cuenta publicitaria → Límite de gasto de la cuenta → Establecer</UI>), por ejemplo igual al tope mensual de la app. Los impuestos (como el IVA) los suma Meta aparte según tu país.
              </Step>
              <Step>
                Vuelve a <Link href="/cuentas" className="font-medium text-primary hover:underline">Cuentas</Link> y pulsa <UI>Sincronizar</UI>: si la cuenta estaba «con pago pendiente», pasa a activa y ya se puede crear anuncios.
              </Step>
            </Steps>
          </Callout>
          <div className="grid gap-4 text-sm leading-relaxed md:grid-cols-2">
            <div className="rounded-lg border border-border p-4">
              <p className="font-semibold">Quién puede qué</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
                <li>Editor: crea anuncios (en pausa) y los pausa.</li>
                <li>Aprobador: activa, cambia presupuestos y archiva.</li>
                <li>Administrador: todo, y fija el tope de cada cuenta.</li>
                <li>Solo lectura: ve los anuncios y las campañas.</li>
              </ul>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="font-semibold">Lo que no hace (todavía)</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
                <li>Anuncios de empleo, vivienda, crédito o temas sociales y políticos: Meta les exige reglas propias.</li>
                <li>Públicos en la Unión Europea (Meta pide datos adicionales, DSA).</li>
                <li>Objetivos de ventas o clientes potenciales (necesitan píxel o formularios). Ni video ni carruseles.</li>
              </ul>
            </div>
          </div>
          <Callout tone="warning" title="Primera vez con una cuenta real">
            <p>
              La creación de anuncios se probó con un Meta simulado, no con una cuenta real: Meta cambia sus reglas seguido y puede rechazar alguna combinación. Como todo nace en pausa, un rechazo no cuesta dinero y la app te muestra el <em>Detalle de Meta</em> tal cual; pégalo para ajustarlo.
            </p>
          </Callout>
        </Section>

        <Section id="permisos" title="Si la app dice que falta el permiso de publicar" intro="Pasa cuando la conexión con Meta se hizo sin pages_manage_posts (Facebook) o instagram_content_publish (Instagram). La app no deja aprobar ni publicar hasta arreglarlo.">
          <Steps>
            <Step>
              En tu app de Meta agrega el caso de uso que da el permiso y comprueba en <UI>Permisos y funciones</UI> que aparece (paso 2).
            </Step>
            <Step>
              Comprueba que tu usuario tiene un rol en la app y control total de la página (pasos 1 y 2).
            </Step>
            <Step>
              Agrega el permiso a <code>META_SCOPES</code> (paso 3) y reinicia la app. Hazlo <UI>después</UI> del primer paso: si no, Facebook responde «Invalid Scopes».
            </Step>
            <Step>
              <Link href="/cuentas" className="font-medium text-primary hover:underline">Cuentas</Link> → <UI>Reconectar Meta</UI> → acepta todo y marca las páginas. El aviso «Sin permiso para publicar» desaparece.
            </Step>
            <Step>
              Abre la publicación que falló y pulsa <UI>Reintentar los que fallaron</UI>.
            </Step>
          </Steps>
          <p className="text-sm text-muted">
            Si Meta sigue rechazando la publicación, el texto <em>«Detalle de Meta»</em> de la ficha dice qué permiso falta. En páginas de un portafolio comercial, para Instagram Meta puede pedir además <code>ads_management</code>.
          </p>
        </Section>

        <Section id="problemas" title="Mensajes frecuentes" intro="Cada uno tal como aparece, qué significa y cómo se arregla.">
          <div className="space-y-2">
            <Problem message="Invalid Scopes: … / «Este contenido no está disponible en este momento» (en la pantalla de Facebook, al conectar)">
              <p>
                Tu app de Meta no tiene habilitado alguno de los permisos de <code>META_SCOPES</code>; el mensaje nombra cuáles. Quita esos nombres de <code>META_SCOPES</code> (o habilítalos en la app, paso 2), reinicia y reconecta. Los permisos
                de Instagram <code>instagram_basic</code> e <code>instagram_content_publish</code> solo se aceptan con la configuración «API setup with Facebook login» del paso 2.
              </p>
            </Problem>
            <Problem message="Sin permiso para publicar (falta pages_manage_posts) / «Meta rechazó la publicación por falta de permisos»">
              <p>
                La conexión no incluye el permiso para publicar. Sigue «Si la app dice que falta el permiso de publicar», arriba.
              </p>
            </Problem>
            <Problem message="«Meta aceptó la conexión pero no devolvió ninguna cuenta»">
              <p>
                Tu usuario no administra ninguna página o cuenta publicitaria, o no las marcaste en la pantalla de Facebook, o tu usuario no tiene rol en la app de Meta. Revisa los pasos 1, 2 y 4.
              </p>
            </Problem>
            <Problem message="No aparece mi página (o la de un portafolio comercial)">
              <p>
                Las páginas que pertenecen a un portafolio solo se listan si se pidió <code>business_management</code> y tu usuario tiene acceso a la página en el portafolio. Reconecta y marca la página en la pantalla de Facebook.
              </p>
            </Problem>
            <Problem message="Conecté Meta pero no aparece mi cuenta de Instagram">
              <p>
                Revisa, en este orden: que la cuenta sea <UI>profesional</UI>, que esté <UI>vinculada a la página</UI> (paso 1), que <code>META_SCOPES</code> incluya <code>instagram_basic</code> e{" "}
                <code>instagram_content_publish</code> (paso 3) y que al reconectar hayas marcado también la cuenta de Instagram.
              </p>
            </Problem>
            <Problem message="«Instagram descarga la imagen desde internet y esta app no es accesible desde fuera (APP_URL es local o no usa HTTPS)»">
              <p>
                La app está en <code>localhost</code>. Facebook sí publica; para Instagram necesitas una dirección pública con HTTPS: tu servidor con dominio o un túnel temporal (paso 6).
              </p>
            </Problem>
            <Problem message="«Instagram no pudo descargar la imagen desde tu servidor»">
              <p>
                Ya hay una dirección pública, pero Meta no llegó a ella: el túnel se cerró, la dirección de <code>MEDIA_PUBLIC_BASE_URL</code> es un ejemplo o está mal escrita, o no reiniciaste la app después de cambiarla. Abre esa dirección +{" "}
                <code>/login</code> en el navegador: si no carga, ese es el problema. La app reintenta sola unas veces; después pulsa <UI>Publicar ahora</UI> o <UI>Reintentar</UI>.
              </p>
            </Problem>
            <Problem message="«Instagram solo acepta imágenes JPG» / «Instagram solo acepta fotos entre formato vertical 4:5 y horizontal 1,91:1»">
              <p>
                Si la imagen quedó guardada como PNG, quítala con <UI>Quitar imagen</UI> y vuelve a subirla (se convierte sola). Si la proporción no cabe en el rango, recórtala antes de subirla.
              </p>
            </Problem>
            <Problem message="«La conexión con Meta venció o fue revocada»">
              <p>
                La conexión dura unos 60 días, o Meta la invalidó (por ejemplo, al cambiar la contraseña de Facebook). Ve a Cuentas → <UI>Reconectar Meta</UI>.
              </p>
            </Problem>
            <Problem message="La publicación quedó «Publicada en parte» (salió en Facebook pero no en Instagram)">
              <p>
                Cada destino se publica por separado. Arregla el motivo que aparece en el destino que falló y pulsa <UI>Reintentar los que fallaron</UI>: solo se repite el que falló, nunca se vuelve a publicar en Facebook.
              </p>
            </Problem>
            <Problem message="«No se encontró el archivo de la imagen en este servidor» (al crear un anuncio nuevo o al publicar)">
              <p>
                La base de datos conoce la imagen pero su archivo ya no está en la carpeta de imágenes (<code>MEDIA_DIR</code>) de este servidor. Pasa por dos motivos: el servidor se <UI>redesplegó sin un volumen</UI> para esa carpeta (en un contenedor,
                todo lo que no está en un volumen se borra al redesplegar), o la publicación se creó en <UI>otra copia de la app</UI> que usa la misma base de datos (por ejemplo tu PC y el servidor): los archivos están en el disco de quien los subió.
              </p>
              <p>
                Para recuperar lo ya perdido: si la publicación <UI>ya salió</UI>, ábrela en Publicaciones; verás «El archivo de esta imagen ya no está en el servidor» con un botón para <UI>volver a subirla</UI>. Tiene que ser la imagen <em>original</em> (la app comprueba que mida lo mismo: así no sirve para cambiar una publicación). Si es un <UI>borrador</UI>, usa <UI>Quitar imagen</UI> y súbela otra vez. Impulsar una publicación <em>ya publicada</em> no necesita la imagen: solo la usa «Anuncio nuevo». Para que no se repita,
                pon <code>MEDIA_DIR</code> en un volumen persistente (en Easypanel: <UI>Mounts → Volume</UI> con la ruta <code>/data/media</code>) y usa una sola copia de la app contra cada base de datos. En «Tu estado ahora» verás cuántas imágenes faltan.
              </p>
            </Problem>
            <Problem message="«Superaría el tope mensual de la cuenta…» (al activar un anuncio o subirle el presupuesto)">
              <p>
                El mensaje dice las tres partes: lo <UI>ya gastado</UI> este mes (lo que Meta reportó), lo que <UI>otros anuncios activos</UI> todavía pueden gastar y lo que gastaría <UI>este</UI>. Si la suma pasa del tope mensual, no se activa. Baja el presupuesto o la duración, pausa otro anuncio, o pídele al administrador que suba el tope mensual en Cuentas. Es una proyección del máximo: Meta puede gastar menos.
              </p>
              <p>
                El gasto del mes sale del rendimiento descargado de Meta, que puede llevar unas horas de retraso; con anuncios activos la app lo vuelve a descargar cada hora.
              </p>
            </Problem>
            <Problem message="«Se pausó automáticamente: el gasto de … llegó al tope mensual de la cuenta»">
              <p>
                Es el freno del tope mensual: el gasto del mes alcanzó el tope y la app pausó los anuncios activos que creó. Puedes volver a activarlos cuando haya cupo (al empezar el mes siguiente, o si el administrador sube el tope). Solo pausa lo creado desde la app: para lo que se active directamente en Meta usa el límite de gasto de la cuenta de Meta.
              </p>
            </Problem>
            <Problem message="«Esta cuenta publicitaria todavía no tiene un tope de gasto diario»">
              <p>
                Sin tope no se puede crear ni activar nada: es la protección principal del dinero. Pídele al administrador que lo fije en <Link href="/cuentas" className="font-medium text-primary hover:underline">Cuentas</Link> (campo «Tope de gasto diario por anuncio» de esa cuenta publicitaria).
              </p>
            </Problem>
            <Problem message="«Meta rechazó la operación por falta de permisos… ads_management» (al crear o activar un anuncio)">
              <p>
                La conexión no incluye <code>ads_management</code>, o tu usuario no tiene acceso a la cuenta publicitaria o a la página. Sigue el paso 1 y 2 de la sección 8, reconecta y vuelve a intentarlo. Si la cuenta es de un portafolio comercial, tu usuario necesita rol de administrador o anunciante en esa cuenta.
              </p>
            </Problem>
            <Problem message="«La cuenta publicitaria no tiene un método de pago válido» / «Hay términos de la cuenta publicitaria sin aceptar»">
              <p>
                Se arregla en Meta, no en la app: en el <Ext href="https://adsmanager.facebook.com">Administrador de anuncios</Ext> → <UI>Facturación y pagos</UI> agrega o corrige el método de pago, o acepta los términos pendientes. Luego vuelve a intentarlo.
              </p>
            </Problem>
            <Problem message="«El presupuesto es menor que el mínimo que Meta permite…»">
              <p>
                Meta exige un mínimo diario que depende de la moneda y de la duración. Sube el presupuesto un poco (sin pasar del tope de la cuenta).
              </p>
            </Problem>
            <Problem message="«Meta registró un presupuesto diario de … Por seguridad se canceló la creación» / «Meta no dejó el anuncio en pausa»">
              <p>
                Es una comprobación de seguridad: la app verificó con Meta lo que acababa de crear y no coincidía con lo pedido (presupuesto distinto o no quedó en pausa), así que lo borró. No se gastó nada. Avisa a quien administra la app: probablemente Meta cambió algo.
              </p>
            </Problem>
            <Problem message="«Meta rechazó la solicitud. Detalle de Meta: …» (al crear un anuncio)">
              <p>
                Meta no aceptó alguna parte del anuncio (objetivo, público, creativo). Lo que se había creado a medias se borró y no se gastó nada. Copia el <em>Detalle de Meta</em>: dice qué campo rechazó y permite ajustar la app. Mientras tanto puedes crear ese anuncio directamente en Meta y administrarlo desde «Campañas en Meta».
              </p>
            </Problem>
            <Problem message="«Una ciudad … está en la Unión Europea: Meta pide datos adicionales (DSA)»">
              <p>
                Para públicos en la Unión Europea Meta exige indicar quién paga y quién se beneficia del anuncio, datos que esta app no recoge. Crea ese anuncio directamente en Meta.
              </p>
            </Problem>
            <Problem message="«(#10) This endpoint requires the 'pages_read_user_content' permission or the 'Page Public Content Access' feature» (al leer estadísticas de Facebook)">
              <p>
                Leer los <UI>comentarios y las reacciones</UI> de una publicación es leer contenido de otras personas, y Meta lo exige con un permiso aparte: <code>pages_read_user_content</code>. Sin él la app no se rinde: lee los compartidos, las vistas y el
                alcance, calcula las reacciones a partir de las estadísticas de la publicación y deja los comentarios en «—» con un aviso.
              </p>
              <p>
                Para tenerlos completos: agrega <code>pages_read_user_content</code> a los permisos de tu app de Meta (paso 7), a <code>META_SCOPES</code> (paso 3), reinicia y pulsa <UI>Reconectar Meta</UI>. «Page Public Content Access» es otra función de Meta, pensada para leer
                páginas que no son tuyas; no la necesitas.
              </p>
            </Problem>
            <Problem message="«Estas cuentas no tienen el permiso read_insights / instagram_manage_insights / pages_read_engagement…» (en Estadísticas)">
              <p>
                La conexión con Meta se hizo sin esos permisos, así que no se leen todas las cifras (o ninguna). Sigue el paso 7: habilítalos en tu app de Meta, agrégalos a <code>META_SCOPES</code>, reinicia y pulsa <UI>Reconectar Meta</UI>. La
                lectura siguiente trae todo y el aviso desaparece.
              </p>
            </Problem>
            <Problem message="«Meta no entregó: alcance / vistas / guardados…» (aviso en una publicación de Estadísticas)">
              <p>
                Meta ya no ofrece esa métrica, o no aplica a ese tipo de publicación. Las demás cifras siguen llegando y la anterior se conserva. Si ocurre en todas las publicaciones, Meta cambió el nombre de la métrica: avisa a quien administra la app para que se actualice.
              </p>
            </Problem>
            <Problem message="«Meta no encuentra esta publicación (la borraron en la red social, o falta un permiso para verla)»">
              <p>
                O la borraron en Facebook o Instagram, o tu usuario ya no tiene acceso a la página o a la cuenta. Sus cifras quedan como estaban; la app lo vuelve a intentar a diario.
              </p>
            </Problem>
            <Problem message="Las cifras salen con «—» o no cambian">
              <p>
                «—» significa que la red no entregó esa cifra (no es 0). Las vistas y el alcance tardan unas horas en aparecer, y Meta actualiza sus cifras con retraso. Pulsa <UI>Actualizar</UI> en Estadísticas para leerlas ya; si sigue igual, mira el aviso
                bajo esa publicación.
              </p>
            </Problem>
            <Problem message="«No se puede cargar la URL. El dominio de esta URL no está incluido en los dominios de la app» (en Facebook, al conectar)">
              <p>
                El dominio con el que abres esta app no está en la lista de tu app de Meta. Ve a <UI>Configuración de la app → Básica → Dominios de la app</UI>, agrega <code>{appHost}</code> (solo el dominio: sin <code>https://</code>, sin el puerto y sin ruta;
                si la usas también en otro lugar, agrega ese dominio también) y pulsa <UI>Guardar cambios</UI>. Vuelve a conectar desde Cuentas.
              </p>
              <p>
                Si sigue igual, comprueba que en <UI>Inicio de sesión de Facebook → Configuración</UI> estén activados <UI>Inicio de sesión de OAuth de cliente</UI> e <UI>Inicio de sesión de OAuth web</UI> y que la dirección de retorno sea exactamente{" "}
                <code className="break-all">{redirectUri}</code>. Y fíjate en la barra de direcciones: debes abrir la app con la misma dirección que tiene <code>APP_URL</code> (<code>{appUrl}</code>); si entras por otra (la IP del servidor, un túnel), Facebook ve otro dominio.
              </p>
            </Problem>
            <Problem message="Facebook muestra un error de «redirect_uri» al conectar">
              <p>
                La dirección de retorno no coincide exactamente con la que registraste en <UI>Inicio de sesión de Facebook → Configuración</UI> (paso 2). Debe ser exactamente: <code className="break-all">{redirectUri}</code>
              </p>
            </Problem>
          </div>
        </Section>
      </div>
    </>
  );
}
