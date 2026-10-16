import { can, type Permission, type RoleName } from "@/lib/permissions";
import type { PostStatusName } from "@/lib/posts";

// Maquina de estados de una publicacion. Las pantallas y las acciones del servidor consultan este mismo
// modulo, asi lo que se muestra como posible y lo que se permite de verdad no pueden diferir.
//
//   DRAFT --enviar--> IN_REVIEW --aprobar--> APPROVED --programar--> SCHEDULED --(hora)--> PUBLISHING --> PUBLISHED
//     ^                  |                       |                       |                                  PARTIAL
//     '------devolver----'                       '-------cancelar--------'                                  FAILED --reintentar--> SCHEDULED

export type PostAction =
  | "submit" // el editor la envia a revision
  | "return" // el aprobador la devuelve al editor con una nota
  | "approve" // aprobarla (con o sin fecha)
  | "schedule" // ponerle fecha, o cambiarla
  | "publishNow" // publicarla ya
  | "cancel" // cancelarla
  | "retry"; // reintentar los destinos que fallaron

type Rule = { from: readonly PostStatusName[]; permission: Permission; label: string };

const RULES: Record<PostAction, Rule> = {
  submit: { from: ["DRAFT"], permission: "content.create", label: "Enviar a revisión" },
  return: { from: ["IN_REVIEW"], permission: "content.approve", label: "Devolver con una nota" },
  approve: { from: ["IN_REVIEW"], permission: "content.approve", label: "Aprobar" },
  schedule: { from: ["APPROVED", "SCHEDULED"], permission: "content.publish", label: "Programar" },
  publishNow: { from: ["APPROVED", "SCHEDULED"], permission: "content.publish", label: "Publicar ahora" },
  cancel: { from: ["IN_REVIEW", "APPROVED", "SCHEDULED"], permission: "content.publish", label: "Cancelar" },
  retry: { from: ["FAILED", "PARTIAL"], permission: "content.publish", label: "Reintentar" },
};

export const ACTION_LABELS: Record<PostAction, string> = Object.fromEntries(
  Object.entries(RULES).map(([k, r]) => [k, r.label]),
) as Record<PostAction, string>;

/** ¿Se puede hacer `action` con una publicacion en `status`? (sin mirar quien lo pide) */
export function canTransition(status: PostStatusName, action: PostAction): boolean {
  return RULES[action].from.includes(status);
}

/** Acciones que una persona con ese rol puede ejecutar ahora sobre una publicacion en ese estado. */
export function availableActions(status: PostStatusName, role: RoleName): PostAction[] {
  return (Object.keys(RULES) as PostAction[]).filter((a) => canTransition(status, a) && can(role, RULES[a].permission));
}

/** Estados en los que la publicacion ya no cambia por si sola (nadie la va a publicar). */
export const FINAL_STATUSES: readonly PostStatusName[] = ["PUBLISHED", "PARTIAL", "FAILED", "CANCELLED"];

/** Con estos estados el proceso en segundo plano puede (o va a) tocar la publicacion: no se edita a mano. */
export const LOCKED_BY_WORKER: readonly PostStatusName[] = ["PUBLISHING"];

// ---------------------------------------------------------------------------
// Programacion
// ---------------------------------------------------------------------------

const MIN_LEAD_MS = 2 * 60_000; // para dar tiempo al proceso en segundo plano
const MAX_AHEAD_MS = 365 * 24 * 60 * 60_000;

/** Motivo por el que una fecha de publicacion no vale, o null si esta bien. */
export function scheduleError(when: Date, now = new Date()): string | null {
  const diff = when.getTime() - now.getTime();
  if (diff < MIN_LEAD_MS) return "La fecha tiene que ser al menos dentro de 2 minutos.";
  if (diff > MAX_AHEAD_MS) return "No se puede programar con más de un año de anticipación.";
  return null;
}
