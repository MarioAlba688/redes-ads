/** Error de Google (OAuth o API de Google Ads), ya clasificado para mostrar un mensaje en español. */
export type GoogleErrorInit = {
  message: string;
  status?: number;
  /** Estado de Google: UNAUTHENTICATED, PERMISSION_DENIED, RESOURCE_EXHAUSTED... */
  googleStatus?: string;
  /** Categoria y valor del error de Google Ads: authorizationError / USER_PERMISSION_DENIED... */
  adsCategory?: string;
  adsValue?: string;
  /** Error del servidor OAuth: invalid_grant, invalid_client... */
  oauthError?: string;
  network?: boolean;
};

export class GoogleApiError extends Error {
  readonly status: number;
  readonly googleStatus?: string;
  readonly adsCategory?: string;
  readonly adsValue?: string;
  readonly oauthError?: string;
  readonly network: boolean;

  constructor(init: GoogleErrorInit) {
    super(init.message);
    this.name = "GoogleApiError";
    this.status = init.status ?? 0;
    this.googleStatus = init.googleStatus;
    this.adsCategory = init.adsCategory;
    this.adsValue = init.adsValue;
    this.oauthError = init.oauthError;
    this.network = init.network ?? false;
  }

  /** Respuesta de error de la API de Google Ads: { error: { code, message, status, details: [{ errors: [{ errorCode: { categoria: VALOR } }] }] } }. */
  static fromAdsResponse(status: number, body: unknown): GoogleApiError {
    const error = (body as { error?: { message?: unknown; status?: unknown; details?: unknown } } | null)?.error;
    let adsCategory: string | undefined;
    let adsValue: string | undefined;
    let detailMessage: string | undefined;
    for (const detail of Array.isArray(error?.details) ? error.details : []) {
      const first = (detail as { errors?: { errorCode?: Record<string, unknown>; message?: unknown }[] } | null)?.errors?.[0];
      const entry = first?.errorCode ? Object.entries(first.errorCode)[0] : undefined;
      if (entry) {
        adsCategory = entry[0];
        adsValue = String(entry[1]);
        detailMessage = typeof first?.message === "string" ? first.message : undefined;
        break;
      }
    }
    return new GoogleApiError({
      message: detailMessage ?? (typeof error?.message === "string" ? error.message : `Google respondio con HTTP ${status}.`),
      status,
      googleStatus: typeof error?.status === "string" ? error.status : undefined,
      adsCategory,
      adsValue,
    });
  }

  /** Respuesta de error del servidor OAuth: { error: "invalid_grant", error_description: "..." }. */
  static fromOAuthResponse(status: number, body: unknown): GoogleApiError {
    const b = body as { error?: unknown; error_description?: unknown } | null;
    return new GoogleApiError({
      message: typeof b?.error_description === "string" ? b.error_description : `Google respondio con HTTP ${status}.`,
      status,
      oauthError: typeof b?.error === "string" ? b.error : undefined,
    });
  }

  /** La conexion ya no sirve (el permiso se revoco, vencio, o la persona cambio su contraseña): hay que reconectar. */
  get isAuthError(): boolean {
    // Un secreto o ID de cliente mal puesto tambien llega como 401, pero reconectar no lo arregla: no es una conexion vencida.
    if (this.isBadClient) return false;
    return (
      this.oauthError === "invalid_grant" ||
      this.status === 401 ||
      this.googleStatus === "UNAUTHENTICATED" ||
      this.adsCategory === "authenticationError"
    );
  }

  /** El ID o el secreto de cliente de OAuth que hay en .env no son validos: es un problema de configuracion, no de la cuenta. */
  get isBadClient(): boolean {
    return this.oauthError === "invalid_client" || this.oauthError === "unauthorized_client";
  }

  /** El proyecto de Google Cloud todavia no tiene acceso a la API de Google Ads en cuentas reales. */
  get isProjectNotApproved(): boolean {
    return (
      this.adsValue === "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" ||
      this.adsValue === "DEVELOPER_TOKEN_NOT_APPROVED" ||
      this.adsValue === "DEVELOPER_TOKEN_PROHIBITED" ||
      this.adsValue === "ACTION_NOT_PERMITTED"
    );
  }

  /** Google pide esperar (demasiadas consultas). */
  get isRateLimit(): boolean {
    return this.status === 429 || this.googleStatus === "RESOURCE_EXHAUSTED" || this.adsCategory === "quotaError";
  }

  /** Tu usuario no tiene acceso a esa cuenta. */
  get isPermissionError(): boolean {
    return this.adsValue === "USER_PERMISSION_DENIED" || this.adsValue === "CUSTOMER_NOT_ENABLED" || this.status === 403;
  }

  /** Mensaje en español, seguro de mostrar a quien usa la app (nunca incluye tokens). */
  get userMessage(): string {
    if (this.network) return "No se pudo contactar a Google (red o tiempo de espera). Intenta de nuevo en unos minutos.";
    if (this.isBadClient) return "Google rechazó el ID o el secreto de cliente de OAuth. Revisa GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el archivo .env.";
    if (this.isAuthError) return "La conexión con Google venció o fue revocada. Vuelve a conectar Google Ads en Cuentas.";
    if (this.isProjectNotApproved) {
      return "Tu proyecto de Google Cloud todavía no tiene acceso a la API de Google Ads con cuentas reales. Pídelo en Google Cloud Console → API de Google Ads (nivel Explorer o Básico).";
    }
    if (this.adsValue === "CUSTOMER_NOT_ENABLED") return "Esta cuenta de Google Ads está cancelada o inactiva.";
    if (this.adsValue === "USER_PERMISSION_DENIED") return "Tu usuario de Google no tiene acceso a esta cuenta de Google Ads.";
    if (this.isRateLimit) return "Google pidió esperar por exceso de consultas. Intenta de nuevo en unos minutos.";
    if (this.isPermissionError) return "Google rechazó la consulta por falta de permisos sobre esta cuenta.";
    if (this.status >= 500) return "Google Ads tuvo un problema temporal. Intenta de nuevo en unos minutos.";
    return `Google devolvió un error: ${this.message.slice(0, 200)}`;
  }
}
