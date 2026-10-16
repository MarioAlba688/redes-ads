// Mensajes compartidos por todos los motores (las pantallas muestran el mismo texto con cualquiera).

export const MSG_REFUSAL = "La IA no quiso redactar esto. Reformula la petición con otro enfoque.";
export const MSG_TRUNCATED = "La respuesta de la IA se cortó. Pide menos opciones o un tema más acotado.";
export const MSG_NETWORK = "No se pudo contactar a la IA (red o tiempo de espera). Inténtalo de nuevo.";
export const MSG_BUSY = "El servicio de IA está saturado o con problemas. Inténtalo en unos minutos.";
export const MSG_RATE = "La IA recibió demasiadas peticiones. Espera un minuto e inténtalo de nuevo.";
export const MSG_UNKNOWN = "No se pudo generar el texto por un error inesperado.";
export const MSG_UNREADABLE = "La IA devolvió una respuesta que no se pudo leer. Inténtalo de nuevo.";
export const MSG_BAD_SHAPE = "La IA devolvió una respuesta con un formato inesperado. Inténtalo de nuevo.";

export const msgBadKey = (label: string) => `La clave de ${label} no es válida. Revísala en Motores de IA.`;
export const msgNoPermission = (label: string) => `La clave de ${label} no tiene permiso para usar este modelo.`;
export const msgNoModel = (model: string) => `El modelo «${model}» no existe o no está disponible para esta cuenta. Cámbialo en Motores de IA (botón «Cargar modelos»).`;
export const msgNoCredit = (label: string, where: string) => `La cuenta de ${label} no tiene saldo o llegó a su límite de gasto. Revísalo en ${where}.`;
export const msgRejected = (detail: string) => `La IA rechazó la petición: ${detail.slice(0, 160)}`;

/**
 * JSON que se le describe al modelo cuando la API no lo fuerza con un esquema (OpenAI en modo simple y Gemini).
 * Se valida igual con zod al recibirlo.
 */
export const JSON_SHAPE_HINT = [
  "# Formato de la respuesta",
  'Responde únicamente con un objeto JSON válido, sin texto antes ni después y sin bloques de código, con esta forma exacta:',
  '{"posts":[{"angle":"enfoque en pocas palabras","text":"texto de la publicación sin hashtags","hashtags":["sinSimboloNumeral"],"image_idea":"idea de la imagen"}]}',
].join("\n");
