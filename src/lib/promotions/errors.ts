import { MetaApiError } from "@/lib/meta/errors";

// Errores de la Marketing API traducidos a mensajes que la persona entiende. Logica pura.

export type AdsFailure = {
  message: string;
  /** La conexion con Meta ya no sirve: hay que marcar la cuenta como vencida. */
  expired: boolean;
  /** Tiene sentido volver a intentarlo mas tarde (caida de red, limite de uso). */
  retryable: boolean;
};

const detail = (e: MetaApiError) => (e.message ? ` Detalle de Meta: ${e.message.slice(0, 300)}` : "");

/** Convierte cualquier fallo al crear o administrar anuncios en un mensaje en español. Nunca incluye tokens ni URLs. */
export function classifyAdsError(e: unknown): AdsFailure {
  if (!(e instanceof MetaApiError)) {
    return { message: "Error interno al hablar con Meta. Revisa los registros del servidor.", expired: false, retryable: false };
  }
  if (e.network) {
    return { message: "No se pudo contactar a Meta (red o tiempo de espera). Intenta de nuevo en unos minutos.", expired: false, retryable: true };
  }
  if (e.isAuthError) {
    return { message: "La conexión con Meta de esta cuenta venció o fue revocada. Reconecta Meta en Cuentas.", expired: true, retryable: false };
  }
  if (e.isRateLimit) {
    return { message: "Meta pidió esperar por exceso de consultas. Intenta de nuevo en unos minutos.", expired: false, retryable: true };
  }
  if (e.status >= 500 || e.code === 1 || e.code === 2) {
    return { message: "Meta tuvo un problema temporal. Intenta de nuevo en unos minutos.", expired: false, retryable: true };
  }
  // Subcódigo 1885183 (error real visto con la cuenta del usuario, 2026-10-16): Meta no deja crear anuncios con una app en modo «Desarrollo».
  if (e.subcode === 1885183 || /modo (de )?desarrollo|development mode/i.test(e.message)) {
    return {
      message: `Tu app de Meta está en modo de desarrollo y Meta solo deja crear anuncios con una app en modo Publicado (público). Publícala en developers.facebook.com → tu app → «Publicar» en el menú de la izquierda (hace falta la URL de la política de privacidad, la de eliminación de datos, el ícono y la categoría) y vuelve a intentarlo.${detail(e)}`,
      expired: false,
      retryable: false,
    };
  }
  if (e.isPermissionError) {
    return {
      message: `Meta rechazó la operación por falta de permisos. La app necesita ads_management, y tu usuario debe tener acceso a la cuenta publicitaria y a la página (como administrador o anunciante en el portafolio comercial).${detail(e)}`,
      expired: false,
      retryable: false,
    };
  }
  if (/payment|billing|funding|método de pago|forma de pago|medio de pago/i.test(e.message)) {
    return {
      message: `La cuenta publicitaria no tiene un método de pago válido. Agrégalo en Meta (Facturación y pagos) y vuelve a intentarlo.${detail(e)}`,
      expired: false,
      retryable: false,
    };
  }
  if (/terms of service|términos|terminos/i.test(e.message)) {
    return {
      message: `Hay términos de la cuenta publicitaria sin aceptar. Acéptalos en Meta (Administrador de anuncios) y vuelve a intentarlo.${detail(e)}`,
      expired: false,
      retryable: false,
    };
  }
  // Meta responde en el idioma de la persona: «debe ser de más de $ 3.322» / «must be more than 3322» / «minimum budget».
  if (/budget|presupuesto/i.test(e.message) && /minimum|mínimo|minimo|too low|bajo|menor|más de|mas de|more than|at least/i.test(e.message)) {
    return {
      message: `El presupuesto es menor que el mínimo que Meta permite para esta cuenta y esta duración. Súbelo un poco.${detail(e)}`,
      expired: false,
      retryable: false,
    };
  }
  return { message: `Meta rechazó la solicitud.${detail(e)}`, expired: false, retryable: false };
}
