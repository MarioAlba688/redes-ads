// Estado de una publicacion a partir del de sus destinos (logica pura, sin base de datos).

export type TargetStatusName = "PENDING" | "PUBLISHING" | "PUBLISHED" | "FAILED";
export type DerivedPostStatus = "PUBLISHING" | "SCHEDULED" | "PUBLISHED" | "PARTIAL" | "FAILED";

/**
 * - Algun destino publicandose -> PUBLISHING.
 * - Ninguno publicandose pero alguno pendiente (esperando un reintento o su turno) -> SCHEDULED: el proceso
 *   en segundo plano la vuelve a tomar cuando toque.
 * - Todos terminaron: todos publicados -> PUBLISHED; ninguno -> FAILED; mezcla -> PARTIAL.
 */
export function derivePostStatus(targets: readonly { status: TargetStatusName }[]): DerivedPostStatus {
  if (targets.length === 0) return "FAILED";
  if (targets.some((t) => t.status === "PUBLISHING")) return "PUBLISHING";
  if (targets.some((t) => t.status === "PENDING")) return "SCHEDULED";
  const published = targets.filter((t) => t.status === "PUBLISHED").length;
  if (published === targets.length) return "PUBLISHED";
  return published === 0 ? "FAILED" : "PARTIAL";
}

/** ¿Es un estado final (nadie mas va a tocar la publicacion sin que alguien lo pida)? */
export const isTerminal = (s: DerivedPostStatus) => s === "PUBLISHED" || s === "PARTIAL" || s === "FAILED";
