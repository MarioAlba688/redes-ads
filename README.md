# Redes

Aplicación web para manejar en un solo lugar las cuentas publicitarias y las redes sociales de un negocio, con IA para generar y programar publicaciones.

> **Estado: Fase 4 (Google Ads y TikTok Ads).** Funcionan el login, el equipo con roles, la conexión con Meta (Facebook, Instagram y Meta Ads), con Google Ads y con TikTok Ads, un panel de anuncios con las tres plataformas y todo el recorrido de una publicación: marcas, generador con IA, borrador, revisión y aprobación, programación, publicación automática en Facebook e Instagram y calendario.
> LinkedIn, el piloto automático y los reportes llegan en las fases siguientes (ver [Plan](#plan-por-fases)).

## Qué incluye hoy

- Inicio de sesión con sesiones guardadas en MySQL (el token de la cookie se guarda con hash).
- Instalación guiada: la primera persona crea la cuenta de administrador en `/setup`.
- Equipo con 4 roles (Administrador, Editor, Aprobador, Solo lectura), invitaciones por link, desactivar usuarios y cambio de contraseña.
- Historial de actividad (quién hizo qué).
- **Meta:** conexión por OAuth (cuentas publicitarias, páginas de Facebook e Instagram), con los tokens guardados **cifrados** (AES-256-GCM). Ver [Conectar Meta](#conectar-meta-facebook-instagram-y-meta-ads).
- **Anuncios:** gasto, impresiones, clics, CTR, CPC y CPM por cuenta y campaña, con gráfica diaria, comparación con el periodo anterior y filtros de 7/30/90 días, por plataforma y por cuenta. Junta **Meta, Google Ads y TikTok Ads** (las monedas distintas nunca se suman; dentro de cada moneda hay un desglose por plataforma).
- **Google Ads y TikTok Ads:** conexión por OAuth y descarga del rendimiento de las campañas, igual que Meta. Ver [Conectar Google Ads](#conectar-google-ads) y [Conectar TikTok Ads](#conectar-tiktok-ads).
- Pantalla **Cuentas** con el estado de cada conexión, cuándo vence y botones de sincronizar y desconectar.
- **Estadísticas** de lo que publicas: vistas, alcance, reacciones, comentarios, compartidos y guardados de cada publicación de Facebook e Instagram, con resumen, gráfico de las mejores, comparación por red y por marca, filtros de periodo y orden, y botón **Actualizar**. Las lee solo el proceso en segundo plano (cada 3 horas los primeros 2 días, luego cada 12 horas y después a diario hasta los 90 días). Ver [Estadísticas de las publicaciones](#estadísticas-de-las-publicaciones).
- **Manual** (menú lateral, para todos los roles): la guía de Facebook e Instagram dentro de la app, paso a paso, con la dirección de retorno de tu `APP_URL` lista para copiar y los mensajes de error más frecuentes. A los administradores les añade el recuadro **Tu estado ahora**, que revisa la configuración real (app de Meta, permisos pedidos, cuentas conectadas, permiso de publicar, dirección pública para las imágenes de Instagram) y enlaza al paso que arregla cada aviso. Los avisos de Cuentas y de una publicación fallida también enlazan a la parte que corresponde.
- **Marcas:** el perfil de cada negocio (qué hace, a quién le habla, tono, palabras prohibidas, hashtags, zona horaria) y qué páginas y cuentas de Instagram le pertenecen. De ahí salen la voz de la IA y los destinos de cada publicación.
- **Publicaciones con IA:** la IA propone varias opciones de texto según la marca y lo que pidas; la persona elige, edita y añade una imagen. Ver [Publicar con IA](#publicar-con-ia-y-flujo-de-aprobación).
- **Varios motores de IA:** Claude (Anthropic), GPT (OpenAI) y Gemini (Google). Un administrador pone la clave y el modelo de cada uno en **Motores de IA** (las claves se guardan cifradas) y cada persona elige con cuál escribir. Ver [Motores de IA](#motores-de-ia-claude-gpt-y-gemini).
- **Flujo de aprobación** (borrador → revisión → aprobada → programada → publicada), **publicación automática** en Facebook e Instagram con reintentos, y **calendario** mensual por marca.

## Requisitos

- Node.js 22 o superior
- MySQL 8 (o 8.4 LTS)

## Puesta en marcha

### 1. Tener MySQL

La opción más fácil en Windows es [Laragon](https://laragon.org/) (incluye MySQL): instálalo, ábrelo y pulsa **Iniciar todo**. Con Laragon el usuario es `root` y la clave está vacía.

Crea la base de datos (desde la terminal de Laragon o cualquier cliente MySQL):

```sql
CREATE DATABASE redes CHARACTER SET utf8mb4;
```

### 2. Configurar la app

```bash
npm install
copy .env.example .env      # en Mac/Linux: cp .env.example .env
```

Abre `.env` y completa:

| Variable | Qué es |
|---|---|
| `DATABASE_URL` | Conexión a MySQL, por ejemplo `mysql://root:@localhost:3306/redes` |
| `APP_URL` | Dirección de la app (`http://localhost:3000` en local). Se usa para los links de invitación. Si empieza con `https://`, la cookie de sesión se marca como segura. |
| `ENCRYPTION_KEY` | Clave para cifrar los tokens de las redes. Genérala con `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Guárdala bien**: si se pierde hay que reconectar todas las cuentas. |
| `SETUP_TOKEN` | Código para crear el primer administrador. Opcional en desarrollo, **obligatorio en producción** (mínimo 8 caracteres). |
| `ANTHROPIC_API_KEY` | **Opcional.** Las claves de la IA se ponen desde la app (**Motores de IA**, ver más abajo). Esta variable solo es un respaldo para Claude: se usa si no hay una clave de Claude guardada en la app. |
| `AI_MODEL`, `AI_EFFORT`, `AI_DAILY_LIMIT` | Modelo de Claude cuando se usa `ANTHROPIC_API_KEY` (por defecto `claude-opus-5-5`), cuánto «piensa» Claude (`low`/`medium`/`high`) y generaciones por persona cada 24 horas, **sumando todos los motores** (40). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Credenciales OAuth de Google Cloud para conectar Google Ads (ver [Conectar Google Ads](#conectar-google-ads)). `GOOGLE_ADS_API_VERSION` (por defecto `v25`) y `GOOGLE_ADS_DEVELOPER_TOKEN` (opcional: Google ya no lo exige) son opcionales. |
| `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET` | Credenciales de tu app de TikTok For Business para conectar TikTok Ads (ver [Conectar TikTok Ads](#conectar-tiktok-ads)). |
| `MEDIA_DIR` | Carpeta de las imágenes de las publicaciones. En el VPS, fuera del código y **con copia de seguridad**. Por defecto `./storage/media`. |
| `MEDIA_PUBLIC_BASE_URL` | Dirección pública desde la que Meta descarga las imágenes para Instagram. Por defecto `APP_URL`. |
| `APP_TIMEZONE` | Zona horaria de las fechas que se muestran (por defecto `America/Bogota`). Importante en un VPS, que suele trabajar en UTC. |
| `WORKER_ENABLED`, `WORKER_INTERVAL_SECONDS` | Proceso en segundo plano que publica lo programado (encendido, cada 30 s). |

### 3. Crear las tablas y arrancar

```bash
npm run db:deploy    # crea las tablas en MySQL (aplica las migraciones de prisma/migrations)
npm run dev
```

> Si tu MySQL está en un VPS, lee antes [Base de datos en un VPS](#base-de-datos-en-un-vps).
> Usa siempre `db:deploy` contra una base con datos reales: `db:migrate` (`prisma migrate dev`) puede proponer **borrar y recrear** la base.

Abre <http://localhost:3000>. Como no hay usuarios, te lleva a crear el administrador.

## Conectar Meta (Facebook, Instagram y Meta Ads)

La conexión usa OAuth: la persona que conecta inicia sesión en Facebook, acepta los permisos y la app guarda las cuentas que esa persona administra. Hay que crear una app propia en Meta (es gratis y no se publica en ninguna tienda).

> Esta misma guía, más detallada y con tu configuración real, está en el menú **Manual** de la app.
>
> Las pantallas de Meta cambian con frecuencia; si algún nombre no coincide, busca el equivalente. La app se probó con un servidor de Meta simulado (ver [pruebas](#pruebas-de-extremo-a-extremo)), **no con credenciales reales**: la primera conexión real es la prueba final.

**Antes de empezar**, la persona que conecte necesita:
- Ser administradora de las páginas de Facebook y de las cuentas publicitarias (directamente o desde el portafolio comercial / Business Manager).
- Para Instagram: una cuenta **profesional** (empresa o creador) vinculada a una página de Facebook.

**Pasos**

1. Entra a <https://developers.facebook.com/apps> → **Crear app**. El asistente tiene 5 pasos (datos de la app, casos de uso, negocio, requisitos, resumen). En *casos de uso* elige los que mencionen **anuncios (Marketing API)**, **páginas de Facebook**, **Instagram** e **inicio de sesión de Facebook**. Meta deja en gris los que son incompatibles entre sí (por ejemplo, "Autenticar con Facebook Login" no se puede mezclar con "Administrar todo en tu página"); si no puedes combinar todos, quédate con los de anuncios y páginas y usa el paso 4 (Facebook Login for Business). Si no encuentras uno, elige **Otro**. Vincula la app al portafolio comercial de tu negocio. Después de crearla, abre cada caso de uso y comprueba en *Permisos y funciones* que aparecen los permisos de la lista de abajo.
2. En **Configuración de la app → Básica** copia el **ID de la app** y la **clave secreta** al archivo `.env` como `META_APP_ID` y `META_APP_SECRET` (la clave secreta nunca se comparte ni se sube a un repositorio).
3. En **Inicio de sesión de Facebook → Configuración**, agrega en **URI de redireccionamiento de OAuth válidos** exactamente `APP_URL` + `/api/meta/callback`:
   - desarrollo: `http://localhost:3000/api/meta/callback`
   - producción: `https://TU-DOMINIO/api/meta/callback` (Meta exige HTTPS salvo en `localhost`)
4. Si Meta solo te deja usar **Facebook Login for Business**, crea allí una *configuración* con tipo de token **User access token** y los permisos de la tabla de abajo, y pon su ID en `META_LOGIN_CONFIG_ID`.
5. **Modo desarrollo:** mientras la app esté en ese modo funciona para las personas con un **rol en la app** (Roles → administradores, desarrolladores o probadores) sobre sus propias cuentas, sin pasar la revisión de Meta. Agrega a tu equipo allí. Usarla con cuentas de otras empresas o personas sin rol exige **App Review** y a veces verificación del negocio, que tardan días o semanas.
6. Reinicia la app → **Cuentas → Conectar Meta**. Al volver de Facebook verás el resumen de lo que se conectó y la descarga de los últimos 90 días empieza sola.

**Permisos que se piden** (todos juntos por defecto, para no tener que reconectar cuando lleguen la publicación y las métricas orgánicas): `ads_read` (leer anuncios), `business_management` (ver las páginas y cuentas publicitarias que pertenecen a un portafolio comercial; sin él solo aparecen las que tu perfil administra directamente), `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`. Sin `ads_read` no se pueden leer los anuncios y la app te lo avisa.

**Si Facebook muestra "Invalid Scopes: …" / "Este contenido no está disponible"** es que tu app de Meta no incluye algunos de esos permisos (por ejemplo, si solo marcaste el caso de uso de anuncios). Mientras tanto, pide solo los que sí tiene con `META_SCOPES` en `.env`, por ejemplo `META_SCOPES="ads_read,pages_show_list,pages_read_engagement"`, y reinicia la app. Con eso se conectan los anuncios y las páginas (sin Instagram); cuando agregues los casos de uso de páginas e Instagram en el panel de Meta, quita la variable y pulsa **Reconectar Meta**.

**Cómo se comporta**

- El token de la persona dura unos **60 días**; la pantalla Cuentas muestra cuándo vence. Antes de esa fecha pulsa **Reconectar Meta**. Si Meta lo invalida antes (cambio de contraseña, revocación), la cuenta pasa a *Vencida* y se avisa en Anuncios. Los tokens de página no vencen mientras el de la persona siga válido.
- La sincronización trae los últimos 30 días, porque Meta sigue ajustando las cifras unos 28 días. Se puede lanzar a mano (botones *Sincronizar*) y el proceso en segundo plano la repite solo cada 6 horas.
- Las fechas van en la **zona horaria de cada cuenta publicitaria** y las **monedas distintas nunca se suman** (hay una sección por moneda). El *alcance* se guarda pero no se muestra sumado porque no se puede sumar entre días.
- **Desconectar** borra los tokens de la base de datos; el historial de anuncios se conserva. Para revocar del todo el acceso, quita la app en Facebook → Configuración → Integraciones.
- El secreto de la app y los tokens nunca llegan al navegador ni a los registros.

## Conectar Google Ads

La conexión usa OAuth: la persona que conecta inicia sesión en Google, acepta el permiso de Google Ads y la app guarda las cuentas a las que esa persona tiene acceso (las directas y, si usa una **cuenta administradora (MCC)**, las cuentas cliente que cuelgan de ella). Solo se **lee** el rendimiento de las campañas; no se crea ni se cambia nada en Google Ads.

> Las pantallas de Google cambian con frecuencia; si algún nombre no coincide, busca el equivalente. Esta conexión se probó con un servidor de Google simulado (ver [pruebas](#pruebas-de-extremo-a-extremo)), **no con credenciales reales**: la primera conexión real es la prueba final.

**Antes de empezar**, la persona que conecte necesita acceso a las cuentas de Google Ads (directamente o a través de la cuenta administradora).

**Pasos**

1. Entra a [console.cloud.google.com](https://console.cloud.google.com) y crea un **proyecto** (por ejemplo «Redes»). Todo lo siguiente va en ese mismo proyecto.
2. **APIs y servicios → Biblioteca** → busca **Google Ads API** → **Habilitar**.
3. **Pantalla de consentimiento de OAuth** (en el menú «Google Auth platform» o «APIs y servicios»): tipo **Externo**, nombre de la app y correo de soporte. En **Acceso a los datos** añade el permiso `https://www.googleapis.com/auth/adwords`. Mientras la app esté en **modo «Prueba»** solo entran los usuarios que añadas como *usuarios de prueba* y **el token de renovación caduca a los 7 días** (habría que reconectar cada semana). Para que dure, pasa el estado de publicación a **«En producción»**: una app sin verificar muestra un aviso de Google al conectar, pero funciona para uso interno de un equipo pequeño.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth** → tipo **Aplicación web**. En **URI de redirección autorizados** pon exactamente `APP_URL` + `/api/google/callback`:
   - desarrollo: `http://localhost:3000/api/google/callback`
   - producción: `https://TU-DOMINIO/api/google/callback`
5. Copia el **ID de cliente** y el **secreto** al archivo `.env` como `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.
6. **Acceso a la API de Google Ads.** Desde septiembre de 2026 Google ya **no usa el «developer token»**: el nivel de acceso lo tiene el **proyecto de Google Cloud** que creó las credenciales. Un proyecto nuevo solo tiene acceso de *prueba* (funciona con cuentas de prueba, **falla con cuentas reales** con el error `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`). Pide el acceso en Cloud Console → **API de Google Ads** (página de resumen): el nivel **Explorer** o **Básico** basta para leer informes (según la documentación de Google, el Básico se revisa de forma automática en minutos, tras la verificación de marca del proyecto). Esto puede cambiar: si Google pide otra cosa, la app muestra el motivo al conectar.
7. Reinicia la app → **Cuentas → Conectar Google Ads** → elige la cuenta de Google y acepta. Al volver verás cuántas cuentas se conectaron y la descarga de los últimos 90 días empieza sola.

**Cómo se comporta**

- Las **cuentas administradoras (MCC)** no se guardan (no tienen anuncios propios); sí sus cuentas cliente. Las canceladas se ignoran. Si una cuenta es de acceso directo y también cuelga de una administradora, se usa el acceso directo.
- El **token de renovación** dura hasta que lo revoques o (en modo «Prueba») 7 días. El de acceso dura 1 hora y la app lo renueva sola, una vez por hora para todas las cuentas de la misma conexión. Si Google lo revoca, la cuenta pasa a *Vencida* y se avisa en Cuentas y Anuncios.
- La sincronización trae los últimos 30 días a mano y 90 al conectar, y el proceso en segundo plano la repite cada 6 horas. Las fechas van en la **zona horaria de cada cuenta**. El gasto viene en micros (millonésimas) y se convierte sin errores de redondeo. Google **no informa el alcance** por campaña y día.
- Si el ID o el secreto de cliente del `.env` están mal, la app lo dice (no lo confunde con una conexión vencida).

## Conectar TikTok Ads

La conexión la autoriza la persona que administra las cuentas publicitarias de TikTok. La app guarda los **anunciantes** que esa persona autorizó y lee el rendimiento de sus campañas (solo lectura). Por ahora solo **anuncios**: publicar videos orgánicos en TikTok no está incluido (exige una auditoría de TikTok y soporte de video).

> Esta conexión se probó con un servidor de TikTok simulado (ver [pruebas](#pruebas-de-extremo-a-extremo)), **no con credenciales reales**. La documentación oficial de TikTok no se puede leer automáticamente, así que los nombres de los endpoints (Marketing API v1.3) se contrastaron con conectores de terceros: la primera conexión real es la prueba final.

**Pasos**

1. Necesitas una cuenta de **TikTok For Business** con las cuentas publicitarias en TikTok Ads Manager, y ser administrador de ellas.
2. Entra a [business-api.tiktok.com/portal](https://business-api.tiktok.com/portal) → **My Apps** → **Create an App**. TikTok revisa las apps antes de dejarlas usar en producción (puede tardar días). Pide los permisos de lectura de **cuentas publicitarias** (*Ad Account Management*) e **informes** (*Reporting*).
3. En la app, configura la **Redirect URL / Advertiser redirect URL** exactamente como `APP_URL` + `/api/tiktok/callback`:
   - desarrollo: `http://localhost:3000/api/tiktok/callback`
   - producción: `https://TU-DOMINIO/api/tiktok/callback`
4. Copia el **App ID** y el **Secret** al archivo `.env` como `TIKTOK_APP_ID` y `TIKTOK_APP_SECRET`.
5. Reinicia la app → **Cuentas → Conectar TikTok** → inicia sesión en TikTok For Business, elige los anunciantes que quieres compartir y autoriza. Al volver verás cuántas cuentas se conectaron y la descarga de los últimos 90 días empieza sola.

**Cómo se comporta**

- El token de la Marketing API **no vence solo** (dura hasta que lo revoques en TikTok o quites el acceso de la app); si se revoca, la cuenta pasa a *Vencida* y hay que reconectar.
- TikTok responde con HTTP 200 incluso cuando hay un error (lo que cuenta es el campo `code`): la app lo entiende y muestra el motivo en español. Los informes diarios **no pueden pasar de 30 días por consulta**, así que 90 días se piden en tres tramos.
- Los datos de TikTok llegan con unas **11 horas de retraso**. Las fechas van en la zona horaria del anunciante.

## Publicar con IA y flujo de aprobación

**Antes de la primera publicación**

1. Como administrador, entra a **Motores de IA** y configura al menos uno (opcional: sin ninguno se escribe a mano). Ver [Motores de IA](#motores-de-ia-claude-gpt-y-gemini). No hace falta reiniciar la app.
2. **Marcas → Nueva marca** (la crea un Administrador o Editor): describe el negocio, el tono, lo que nunca debe decirse y marca qué páginas de Facebook y cuentas de Instagram son de esa marca. Cuanto mejor la describas, mejores salen los textos.
3. Para publicar de verdad, tu app de Meta necesita los permisos `pages_manage_posts` (Facebook) e `instagram_content_publish` (Instagram), o sea los casos de uso de **páginas** e **Instagram** (ver [Conectar Meta](#conectar-meta-facebook-instagram-y-meta-ads)); después **Reconectar Meta** en Cuentas.

**El recorrido de una publicación**

| Paso | Quién | Qué pasa |
|---|---|---|
| Crear | Administrador, Editor | *Publicaciones → Nueva publicación*: eliges la marca, cuentas de qué quieres publicar y la IA propone opciones. Eliges una, la editas, marcas los destinos, añades una imagen (JPG o PNG, máx. 8 MB; los PNG se convierten solos a JPG al subirlos) y guardas el **borrador**. |
| Enviar a revisión | Administrador, Editor | La app comprueba antes todo lo que haría fallar la publicación (texto vacío o demasiado largo, destino desconectado, imagen que Instagram rechazaría). |
| Aprobar o devolver | Administrador, Aprobador | **Aprobar** (opcionalmente con fecha y hora, que quedan programadas) o **devolver con una nota** para que el editor corrija. |
| Programar o publicar ya | Administrador, Aprobador | Fecha y hora en la zona horaria de la marca (mínimo 2 minutos adelante). *Publicar ahora* sale en segundos. También se puede **cancelar**. |
| Publicación | Proceso en segundo plano | A la hora indicada se publica en cada destino. El resultado y los enlaces quedan en la ficha, con su historial. |

Un rol de **Solo lectura** ve las publicaciones, el calendario y el historial, pero no puede cambiar nada.

**Cómo se comporta la publicación automática**

- El **proceso en segundo plano** vive dentro del servidor de la app y revisa cada 30 segundos. Necesita un servidor que se quede encendido (tu VPS), no sirve en plataformas «serverless». Si hay dos copias de la app contra la misma base, no se publica nada dos veces (cada destino se reserva con una actualización condicional).
- Cada destino (página de Facebook, cuenta de Instagram) se publica **por separado**. Si uno falla y otro sale, la publicación queda *Publicada en parte* y **Reintentar** solo repite los que fallaron: nunca se vuelve a publicar lo que ya salió.
- Ante un fallo **temporal** (error de Meta, límite de uso, caída de red) reintenta con esperas de 2, 10 y 30 minutos y, tras 4 intentos, la marca como fallida. Ante uno **definitivo** (faltan permisos, conexión vencida, imagen rechazada) no insiste y explica el motivo en español. Si la conexión de una cuenta venció, se marca como *Vencida* en Cuentas y no se puede aprobar nada hacia ella hasta reconectar.
- Si el servidor se cae **a mitad** de una publicación, ese destino no se repite a ciegas (podría salir duplicado): pasa a *Falló* con el aviso «revisa en la red social si salió antes de reintentar».
- El límite de caracteres, los enlaces y las imágenes se validan según la red social de cada destino: por ejemplo, en Instagram el enlace del texto no es pulsable y la foto debe ser **JPG** con formato entre 4:5 (vertical) y 1,91:1 (horizontal).

**Si sale «Meta rechazó la publicación por falta de permisos»:** la conexión con Meta se hizo sin el permiso de publicar (`pages_manage_posts` para Facebook, `instagram_content_publish` para Instagram). Es lo normal si tu app de Meta empezó solo con anuncios. La pantalla **Cuentas** lo avisa en cada página afectada («Sin permiso para publicar») y la app impide enviar a revisión, aprobar o publicar hasta arreglarlo. Pasos, en este orden:
1. En [developers.facebook.com](https://developers.facebook.com/apps) → tu app → **Casos de uso**: añade el de **Administrar todo en tu página** (incluye `pages_manage_posts`) y, para Instagram, el de contenido de Instagram (`instagram_basic`, `instagram_content_publish`; la cuenta de Instagram debe ser profesional y estar vinculada a la página). Si Meta no te deja combinarlos con el inicio de sesión, usa **Facebook Login for Business** (paso 4 de [Conectar Meta](#conectar-meta-facebook-instagram-y-meta-ads)) con esos permisos.
2. En modo desarrollo, tu usuario debe tener un **rol en la app** y **control total de la página** (Configuración del negocio → Páginas → tu página → personas).
3. En `.env`, añade los permisos a `META_SCOPES` (por ejemplo `ads_read,business_management,pages_show_list,pages_read_engagement,pages_manage_posts`) o **quita la variable** para pedirlos todos, y reinicia la app. No lo hagas antes del paso 1: Facebook respondería «Invalid Scopes».
4. **Cuentas → Reconectar Meta**, acepta todos los permisos y marca las páginas. El aviso desaparece y en la publicación fallida puedes pulsar **Reintentar**.

**Instagram necesita que la app sea accesible desde internet.** Meta no recibe la imagen: la **descarga** desde una dirección pública. Por eso `APP_URL` (o `MEDIA_PUBLIC_BASE_URL`) tiene que ser un dominio con **HTTPS**. En `localhost` Facebook sí funciona (se sube el archivo), Instagram no, y la app lo avisa antes de intentarlo. Las imágenes de una publicación solo son públicas mientras está *programada*, *publicándose* o *publicada*; en borrador o en revisión solo las ve quien tiene sesión.

**Qué guardar en las copias de seguridad:** la base de datos **y la carpeta de imágenes** (`MEDIA_DIR`, por defecto `storage/media`).

**Todavía no incluye:** carruseles, vídeo, historias ni más de una imagen por publicación.

## Estadísticas de las publicaciones

La pantalla **Estadísticas** (menú lateral, la ven todos los roles) muestra cómo les va a las publicaciones que salieron en Facebook e Instagram **desde la app** (las que subas a mano a la red social no se miden):

- **Vistas** (veces que se mostró, con repeticiones), **alcance** (personas distintas), **reacciones** («me gusta» en Instagram), **comentarios**, **compartidos** y **guardados** (solo Instagram), y la **interacción por alcance** (interacciones ÷ personas alcanzadas).
- Resumen del periodo (7, 30 o 90 días), gráfico de las publicaciones con más interacciones, comparación por red y por marca, la lista completa con orden y la **mejor publicación**. La ficha de cada publicación también resume sus cifras.
- **Se actualizan solas**: el proceso en segundo plano lee las cifras minutos después de publicar y las repite cada 3 horas los primeros 2 días, cada 12 horas hasta las 2 semanas y una vez al día hasta los 90 días. **Actualizar** las lee al momento (las 12 más recientes de lo que estás viendo; quien solo lee no tiene el botón).
- «—» significa que la red no entregó esa cifra; no es lo mismo que 0. Las vistas y el alcance pueden tardar unas horas en aparecer.

**Permisos de Meta** (se piden al conectar; están en la lista por defecto): `pages_read_engagement` y `read_insights` para Facebook, `instagram_basic` e `instagram_manage_insights` para Instagram. Si tu `META_SCOPES` del `.env` no los incluye, agrégalos (la línea recomendada está en el Manual, sección 7), habilítalos en los casos de uso de tu app de Meta y pulsa **Reconectar Meta**. Sin el permiso de estadísticas la pantalla lo avisa por cuenta y sigue mostrando lo que sí se puede leer.

**Meta cambia sus métricas cada pocos meses** (en 2025 retiró las «impresiones» y puso «vistas» y «alcance»). La lectura es tolerante: si Meta retira una, las demás siguen llegando, se conserva el valor anterior y la publicación muestra qué cifra faltó. Los nombres de las métricas están en `src/lib/meta/post-metrics.ts`. Se probaron con un Meta simulado, **no con una cuenta real**: la primera lectura real es la prueba final.

Necesita una tabla nueva (`PostTargetMetrics`, migración `stats_metrics`): aplícala con `npm run db:deploy`.

## Motores de IA (Claude, GPT y Gemini)

La pantalla **Motores de IA** (solo para el Administrador) permite dejar configuradas varias inteligencias artificiales y que cada persona elija con cuál escribir al crear una publicación. No se toca el `.env` ni se reinicia nada.

1. **Consigue una clave** en el panel de cada proveedor (los enlaces están en cada tarjeta): [Anthropic](https://console.anthropic.com/settings/keys) para Claude, [OpenAI](https://platform.openai.com/api-keys) para GPT y [Google AI Studio](https://aistudio.google.com/apikey) para Gemini. Cada proveedor cobra por uso en su propia cuenta; hace falta saldo cargado.
2. En la tarjeta del motor, **pega la clave**, deja o cambia el **modelo** y pulsa **Guardar**. La clave se guarda **cifrada** (AES-256-GCM, con `ENCRYPTION_KEY`) y **no se vuelve a mostrar**: solo verás cómo termina. Para cambiarla, pega otra; para conservarla, deja el campo vacío.
3. Pulsa **Probar conexión**: hace una generación mínima y dice si la clave y el modelo funcionan (o por qué no). **Cargar modelos** pregunta a la API qué modelos ve tu cuenta y los ofrece al escribir el nombre: los nombres cambian cada pocos meses, por eso no están fijos en el código. Los modelos que se proponen al principio son orientativos.
4. Marca el **motor por defecto** (el que aparece elegido en el editor; si no eliges uno se usa el primero disponible). Con varios motores listos, el editor muestra un selector «Motor de IA»; con uno solo, lo usa directamente.
5. **Desmarcar «Disponible para el equipo»** conserva la clave pero quita el motor del editor; **Quitar clave** la borra.

Cosas a saber:
- El **límite diario** (`AI_DAILY_LIMIT`) es por persona y se suma entre todos los motores.
- **Todos los motores pasan por las mismas reglas**: perfil de la marca, palabras prohibidas (si una opción las usa se descarta en el servidor, sin fiarse del modelo), hashtags y límites de caracteres.
- Si ya tenías `ANTHROPIC_API_KEY` en el `.env`, sigue funcionando como respaldo para Claude; una clave de Claude guardada en la app tiene prioridad.
- Los errores de cada API se explican en español («la clave no es válida», «el modelo no existe», «sin saldo», «demasiadas peticiones»…) y nunca incluyen la clave. Ante límites de uso o caídas temporales se reintenta solo.
- Para sumar otro proveedor basta un archivo en `src/lib/ai/engines/` y su entrada en `src/lib/ai/catalog.ts`.

## Base de datos en un VPS

**1. Usa un usuario propio, no `root`.** En el MySQL del VPS:

```sql
CREATE USER 'redes_app'@'IP_DE_TU_APP' IDENTIFIED BY 'una-clave-larga-y-unica' REQUIRE SSL;
GRANT ALL PRIVILEGES ON `db-redes`.* TO 'redes_app'@'IP_DE_TU_APP';
```

(Los acentos graves son necesarios si el nombre tiene guion.) Así, si se filtra la clave de la app, solo queda expuesta esa base y no todo el servidor. `REQUIRE SSL` obliga a conectar cifrado.

**2. Escribe la URL en `.env`** con el host, el puerto y la base reales:

```
DATABASE_URL="mysql://redes_app:CLAVE_CODIFICADA@IP_DEL_VPS:PUERTO/db-redes?sslaccept=accept_invalid_certs"
```

- Las claves con símbolos van codificadas (`#` → `%23`, `@` → `%40`). Ver `.env.example`.
- `accept_invalid_certs` cifra la conexión pero **no comprueba que el servidor sea el tuyo**; es un parche. Lo correcto es `sslaccept=strict` con un certificado válido para el nombre o IP del servidor (por ejemplo, de Let's Encrypt) o, si es propio, `&sslcert=/ruta/ca.pem`.
- Sin ningún parámetro `ssl…` la clave y los datos viajan **sin cifrar**.

**3. No dejes el puerto abierto a todo internet.** Con el firewall del VPS (`ufw`, o el del proveedor) permite el puerto de MySQL solo desde la IP donde corre la app. Si accedes desde tu PC para desarrollar, otra opción es un túnel SSH y no abrir el puerto: `ssh -L 3307:127.0.0.1:3306 usuario@tu-vps`, y en la URL `127.0.0.1:3307`.

**4. Las tablas se crean con `npm run db:deploy`.** La base debe estar vacía o ser solo de esta app: si ya tiene tablas llamadas `User`, `Session`, etc., la migración falla en lugar de pisarlas. `DB_SYNCHRONIZE` (de otros frameworks) no se usa aquí; el esquema lo controlan las migraciones de Prisma.

**5. Rendimiento.** La app consulta MySQL en cada petición (así la revocación de accesos es inmediata). Si la app corre lejos del VPS, cada página sumará la latencia de red varias veces; lo ideal es que la app y la base estén en el mismo servidor o en la misma región.

**6. Copias de seguridad.** Programa un `mysqldump` diario en el VPS y guarda las copias fuera de ese servidor, por ejemplo: `mysqldump --single-transaction -u redes_app -p db-redes | gzip > redes-$(date +%F).sql.gz`.

## Desplegar con Docker (Easypanel)

El repo trae un `Dockerfile` listo. En Easypanel: **+ Service → App**, fuente GitHub (rama `main`) y, en **Build**, elige **Dockerfile**. Las variables van en la pestaña **Environment** (nunca dentro de la imagen) y son las mismas de la tabla de [Configurar la app](#2-configurar-la-app); `APP_URL` debe ser la dirección pública con `https://`.

- **Migraciones:** el contenedor ejecuta `prisma migrate deploy` en cada arranque, antes de encender la app (no hace nada si ya están aplicadas). `RUN_MIGRATIONS=false` lo salta.
- **Imágenes:** viven en `/data/media` (`MEDIA_DIR`). Crea un **Volume** en **Mounts** con esa ruta de montaje; sin él se pierden al redesplegar. Entra en las copias de seguridad.
- **Puerto y dominio:** la app escucha en el `3000`; en **Domains & Proxy** añade tu dominio apuntando a ese puerto, con HTTPS.
- **Una sola réplica:** el proceso que publica lo programado corre dentro de la app.
- **Base de datos:** si MySQL es otro servicio de Easypanel, usa su host interno (`proyecto_servicio:3306`) y quita los `?ssl…` de la `DATABASE_URL`: así la app queda a milisegundos de la base.
- **Después de desplegar:** añade `https://tu-dominio/api/meta/callback`, `/api/google/callback` y `/api/tiktok/callback` como URL de redirección en cada plataforma.

Para probar la imagen en tu PC: `docker build -t redes .` y `docker run --env-file .env -p 3000:3000 -v redes-media:/data/media redes`.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` / `npm start` | Compilar y correr en producción |
| `npm run db:migrate -- --name <cambio>` | Crear una migración nueva (**solo contra una base local de desarrollo**) |
| `npm run db:deploy` | Aplicar migraciones pendientes (producción y bases remotas) |
| `npm run db:studio` | Explorar la base de datos en el navegador |
| `npx prisma generate` | Regenerar el cliente de Prisma tras cambiar `schema.prisma` (también corre al hacer `npm install`) |
| `npm test` | Pruebas unitarias (permisos, cifrado, contraseñas, cliente de Meta, informes) |
| `npm run test:e2e` | Prueba de extremo a extremo de la Fase 1 con navegador real (ver abajo) |
| `npm run test:e2e:meta` | Prueba de extremo a extremo de Meta contra un servidor de Meta simulado (ver abajo) |
| `npm run test:e2e:content` | Marcas y generador con IA contra un Claude simulado (ver abajo) |
| `npm run test:e2e:ads` | Google Ads y TikTok Ads: conexión, cuentas de una MCC, renovación de tokens, sincronización, Anuncios con varias plataformas, errores y permisos, contra servidores simulados |
| `npm run test:e2e:engines` | Varios motores de IA (Claude, GPT, Gemini): configuración, claves cifradas, selector y errores, contra servidores simulados |
| `npm run test:e2e:pipeline` | Recorrido completo de una publicación (revisión, aprobación, programación, publicación, reintentos, calendario) contra un Meta simulado |
| `npm run test:e2e:stats` | Estadísticas de las publicaciones: lectura automática, calendario de relecturas, «Actualizar», permisos que faltan, métricas retiradas y errores de Meta, contra un Meta simulado |
| `npm run typecheck` / `npm run lint` | Revisión de tipos y estilo |

## Pruebas de extremo a extremo

Abren Chrome, recorren la app como una persona real y comprueban el resultado directamente en MySQL. **Vacían la base de datos al empezar**, por eso usan una base aparte cuyo nombre termine en `_test` (los scripts se niegan a correr contra otra).

- `npm run test:e2e`: instalación, login, invitaciones, roles, bloqueo, cambio de contraseña y cierre de sesión (la app se arranca a mano, ver abajo).
- `npm run test:e2e:content`: marcas y generador de textos, con un servidor que imita a Claude (no gasta dinero ni necesita clave): palabras prohibidas, errores de la API, límite diario y permisos por rol.
- `npm run test:e2e:ads`: Google Ads y TikTok Ads contra servidores que imitan a Google y a TikTok: conexión (con los parámetros exactos que reciben), cuentas directas y de una administradora (MCC), renovación del token de acceso (una sola vez para varias cuentas), sincronización de 90 días (TikTok en tramos de 30), cifras exactas, Anuncios con varias plataformas y su filtro y desglose, límites de uso, tokens revocados, cancelar o repetir una conexión, desconexión, proceso en segundo plano, solo lectura y qué pasa sin credenciales.
- `npm run test:e2e:engines`: la pantalla Motores de IA y el selector del editor con tres servidores simulados (Claude, OpenAI y Gemini): claves cifradas en la base, que nunca llegan a pantallas, registros ni auditoría, prueba de conexión, listado de modelos, errores propios de cada API, motor por defecto, motores desactivados o sin clave, límite diario compartido y permisos (incluida una petición fabricada por un editor).
- `npm run test:e2e:pipeline`: la publicación de principio a fin contra un Meta simulado: imágenes, revisión y aprobación, programación en la zona horaria de la marca, publicación en segundo plano en Facebook e Instagram, reintentos con espera, fallos de permisos y de conexión, publicación parcial, cancelación, recuperación tras una caída, dos procesos compitiendo por la misma publicación, calendario y permisos por rol.
- `npm run test:e2e:stats`: las estadísticas de lo publicado contra un Meta simulado con cifras conocidas: el proceso en segundo plano lee solo lo que toca (y no lo antiguo, lo fallido ni los borradores), guarda cada cifra tal cual, programa las relecturas según la edad, y ante fallos (sin permiso de insights, métrica retirada, límite de uso, publicación borrada, conexión vencida) conserva lo ya leído y lo explica; además la pantalla (tarjetas, tablas, filtros, orden, avisos), «Actualizar», el Manual y los permisos por rol.
- `npm run test:e2e:meta`: conexión OAuth, cuentas, sincronización, pantalla de anuncios, tokens vencidos, límites de uso, permisos rechazados, desconexión y permisos por rol. **Arranca solo** la app (hay que haber hecho `npm run build`) y un servidor que imita a Meta, así que no necesita credenciales ni toca Meta de verdad (`content` y `pipeline` también arrancan solos la app):

```bash
# base de pruebas con las tablas al día (PowerShell):
$env:DATABASE_URL = "mysql://root:@localhost:3306/redes_test"
npm run db:deploy
npm run build
$env:E2E_DATABASE_URL = "mysql://root:@localhost:3306/redes_test"
npm run test:e2e:meta        # opcional: $env:E2E_SHOTS_DIR = "ruta" guarda capturas de pantalla
# opcional: simular una base lejana (~200 ms por consulta, como un VPS):
$env:E2E_DB_LATENCY_MS = "100"; npm run test:e2e:meta
```

Para `test:e2e` (Fase 1) la app se arranca antes contra la base de pruebas:

```bash
# 1. Crear la base de pruebas en MySQL:  CREATE DATABASE redes_test CHARACTER SET utf8mb4;
# 2. Aplicar las tablas y arrancar la app contra ella (PowerShell):
$env:DATABASE_URL = "mysql://root:@localhost:3306/redes_test"
$env:APP_URL = "http://localhost:3100"
$env:SETUP_TOKEN = "codigo-de-prueba-123"
npm run db:deploy
npm run build
npm start -- -p 3100
# 3. En otra terminal:
$env:E2E_DATABASE_URL = "mysql://root:@localhost:3306/redes_test"
npm run test:e2e
```

Variables opcionales: `E2E_BASE_URL` (por defecto `http://localhost:3100`), `E2E_SETUP_TOKEN` y `CHROME_PATH` si Chrome no está en una ruta habitual.

## Estructura

```
prisma/schema.prisma      Tablas: usuarios, sesiones, invitaciones, historial, cuentas conectadas, rendimiento diario de anuncios
src/proxy.ts              Redirige a /login si no hay cookie (chequeo rápido, sin base de datos)
src/lib/auth/             Sesiones y control de acceso (requireUser, authorize)
src/lib/permissions.ts    Qué puede hacer cada rol
src/lib/crypto.ts         Hash de tokens y cifrado de secretos
src/lib/ads/             Lo común a todas las plataformas de anuncios: conector, sincronización, guardado de métricas y de cuentas
src/lib/google/          Google Ads: OAuth, cliente REST, cuentas (MCC), métricas (GAQL) y renovación de tokens
src/lib/tiktok/          TikTok Ads: OAuth, cliente de la Marketing API, anunciantes y reportes
src/lib/meta/             Cliente de la API de Meta: OAuth, cuentas, métricas, sincronización, informes y publicación (publish.ts)
src/lib/ai/               Generador de textos: perfil de marca, reglas, límite diario y motores guardados (providers.ts)
src/lib/ai/engines/       Un archivo por proveedor de IA (anthropic, openai, gemini) con la misma interfaz
src/lib/publishing/       Publicación en segundo plano: estados (status.ts) y vuelta del worker (run.ts)
src/lib/post-workflow.ts  Máquina de estados de una publicación (qué acción es posible y para qué rol)
src/lib/worker.ts         Proceso en segundo plano (se arranca desde src/instrumentation.ts)
src/app/api/meta/         /connect (empieza el OAuth) y /callback (vuelta de Facebook); igual en api/google/ y api/tiktok/
src/app/api/posts/        Subida de la imagen de un borrador
src/app/media/            Sirve las imágenes (públicas solo mientras la publicación está programada o publicada)
src/app/(auth)/           Login, instalación e invitaciones
src/app/(app)/            Panel, Cuentas, Anuncios, Marcas, Publicaciones (lista, ficha y calendario), Equipo y Perfil (requieren sesión)
e2e/                      Pruebas con navegador real y los servidores simulados de Meta (fake-meta.mjs) y Claude (fake-anthropic.mjs)
```

## Seguridad: cómo está resuelto

- **La sesión se valida en MySQL en cada petición.** Si desactivas a alguien o le cambias el rol, el efecto es inmediato. Por eso `cacheComponents` está desactivado en `next.config.ts`.
- **Cada página y cada acción** vuelve a verificar la sesión y el permiso (`requireUser` / `authorize`); ocultar un botón en la pantalla no se considera protección.
- Contraseñas con bcrypt, bloqueo temporal tras 5 intentos fallidos y tiempo de respuesta uniforme exista o no el correo.
- Los tokens de las redes sociales y las claves de los motores de IA se guardan cifrados y las pantallas nunca los leen (de una clave de IA solo se guardan, en claro, los últimos 4 caracteres para reconocerla). Solo el Administrador las configura, las acciones lo re-verifican en el servidor, y las claves nunca aparecen en errores, registros ni historial.
- La conexión con Meta protege el `state` (cookie de un solo uso) contra conexiones forzadas, firma cada llamada con `appsecret_proof`, no sigue URLs que devuelva Meta y no deja tokens en los errores ni en el historial.
- Google y TikTok siguen el mismo patrón seguro que Meta: `state` de un solo uso en una cookie, tokens (incluido el de renovación de Google) guardados cifrados y nunca mostrados, y errores que no incluyen tokens ni URLs.
- Solo el administrador conecta, sincroniza o desconecta cuentas; el resto del equipo puede ver los anuncios según su rol.
- El flujo de aprobación lo hace cumplir el servidor, no los botones: cada acción vuelve a comprobar el permiso y que el estado actual la permita (una petición fabricada por un editor para «aprobar» se rechaza). Las imágenes se validan por su contenido (no por la extensión), con nombres aleatorios, y la subida rechaza otros orígenes y peticiones sin sesión.
- Las llamadas de datos (`/api`) sin sesión reciben un 401 y no una redirección; solo las páginas mandan a iniciar sesión.
- Cabeceras contra clickjacking y sniffing (`next.config.ts`).
- En producción sirve la app por **HTTPS** y usa un `APP_URL` con `https://`.

Pendiente para antes de publicar en internet: política de contenido (CSP), límite de intentos por IP además del bloqueo por cuenta, y copias de seguridad de MySQL.

## Plan por fases

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Base: proyecto, MySQL, login, equipo y roles, pantalla de cuentas | **Hecha** |
| 2 | Meta: conexión por OAuth, cuentas, métricas de anuncios y panel de Anuncios | **Hecha** (la conexión se probó con una app de Meta real; el gasto aparece cuando las cuentas tengan anuncios) |
| 3 | IA y publicación: perfil de marca, generador de posts con Claude, calendario, aprobación, **publicación en Facebook e Instagram** y proceso en segundo plano (también sincronización automática) | **Hecha** con servidores simulados; falta la prueba real con tu clave de Claude y los permisos de publicación de Meta |
| 4 | Google Ads y TikTok (anuncios: conexión y métricas, junto a Meta en Anuncios) | **Hecha** con servidores simulados; falta la prueba real con tus credenciales de Google Cloud y TikTok For Business. La publicación orgánica en TikTok queda fuera por ahora |
| 5 | LinkedIn | Pendiente |
| 6 | Piloto automático, alertas, reportes y despliegue | Pendiente |

> Las aprobaciones de las plataformas (Meta, Google Ads, TikTok, LinkedIn) tardan días o semanas: conviene solicitarlas desde ya.
