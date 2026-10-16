/** Datos de un error de la Graph API: https://developers.facebook.com/docs/graph-api/guides/error-handling */
export type GraphErrorBody = {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
};

// Limites de uso: la app, la cuenta o el usuario hicieron demasiadas llamadas.
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, ...Array.from({ length: 15 }, (_, i) => 80000 + i)]);

export class MetaApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly type?: string;
  readonly fbtraceId?: string;
  /** No hubo respuesta de Meta: caida de red o tiempo de espera agotado. */
  readonly network: boolean;

  constructor(init: {
    message: string;
    status?: number;
    code?: number;
    subcode?: number;
    type?: string;
    fbtraceId?: string;
    network?: boolean;
  }) {
    super(init.message);
    this.name = "MetaApiError";
    this.status = init.status ?? 0;
    this.code = init.code;
    this.subcode = init.subcode;
    this.type = init.type;
    this.fbtraceId = init.fbtraceId;
    this.network = init.network ?? false;
  }

  static fromResponse(status: number, body: GraphErrorBody | null): MetaApiError {
    const e = body?.error;
    return new MetaApiError({
      message: e?.error_user_msg ?? e?.message ?? `Meta respondio con HTTP ${status}.`,
      status,
      code: e?.code,
      subcode: e?.error_subcode,
      type: e?.type,
      fbtraceId: e?.fbtrace_id,
    });
  }

  /** El token ya no sirve (vencio, se revoco o la persona cambio su clave): hay que reconectar. */
  get isAuthError(): boolean {
    return this.code === 190 || this.status === 401;
  }

  /** Meta pide esperar antes de reintentar. */
  get isRateLimit(): boolean {
    return this.code !== undefined && RATE_LIMIT_CODES.has(this.code);
  }

  /** Falta un permiso o la persona no tiene acceso a ese recurso. */
  get isPermissionError(): boolean {
    return this.code === 10 || (this.code !== undefined && this.code >= 200 && this.code < 300);
  }

  /** Mensaje en español, seguro de mostrar a quien usa la app. */
  get userMessage(): string {
    if (this.network) return "No se pudo contactar a Meta (red o tiempo de espera). Intenta de nuevo en unos minutos.";
    if (this.isAuthError) return "La conexión con Meta venció o fue revocada. Vuelve a conectar la cuenta.";
    if (this.isRateLimit) return "Meta pidió esperar por exceso de consultas. Intenta de nuevo en unos minutos.";
    if (this.isPermissionError) return "Meta rechazó la consulta por falta de permisos sobre esta cuenta.";
    return `Meta devolvió un error: ${this.message.slice(0, 200)}`;
  }
}
