/**
 * Error de la API de TikTok Ads. TikTok responde HTTP 200 incluso con errores: lo que manda es el campo `code`
 * del cuerpo (0 = bien). Los codigos que se reconocen son los que documenta TikTok y los que reportan los conectores
 * de terceros; cualquier otro se muestra con el texto de TikTok.
 */
export class TikTokApiError extends Error {
  readonly status: number;
  /** Codigo de TikTok (40105, 40100...); 0 si el fallo fue de red o de HTTP. */
  readonly code: number;
  readonly network: boolean;

  constructor(init: { message: string; status?: number; code?: number; network?: boolean }) {
    super(init.message);
    this.name = "TikTokApiError";
    this.status = init.status ?? 0;
    this.code = init.code ?? 0;
    this.network = init.network ?? false;
  }

  /** El token ya no sirve (se revoco o la persona quito el acceso): hay que reconectar. */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === 40104 || this.code === 40105 || (this.code >= 40100 && this.code <= 40199 && /access token|authoriz/i.test(this.message) && !this.isRateLimit);
  }

  /** TikTok pide esperar («requests made too frequently»). */
  get isRateLimit(): boolean {
    return this.status === 429 || this.code === 40100 || this.code === 40016 || this.code === 40133;
  }

  /** Falla temporal del servidor de TikTok. */
  get isTemporary(): boolean {
    return this.status >= 500 || [50000, 51002, 51004, 51041, 60001].includes(this.code);
  }

  /** Mensaje en español, seguro de mostrar a quien usa la app (nunca incluye tokens). */
  get userMessage(): string {
    if (this.network) return "No se pudo contactar a TikTok (red o tiempo de espera). Intenta de nuevo en unos minutos.";
    if (this.isAuthError) return "La conexión con TikTok venció o fue revocada. Vuelve a conectar TikTok Ads en Cuentas.";
    if (this.isRateLimit) return "TikTok pidió esperar por exceso de consultas. Intenta de nuevo en unos minutos.";
    if (this.isTemporary) return "TikTok tuvo un problema temporal. Intenta de nuevo en unos minutos.";
    if (/permission|scope|not authoriz/i.test(this.message)) return "TikTok rechazó la consulta por falta de permisos sobre esta cuenta.";
    return `TikTok devolvió un error${this.code ? ` (${this.code})` : ""}: ${this.message.slice(0, 200)}`;
  }
}
