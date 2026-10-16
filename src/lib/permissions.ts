export const ROLES = ["ADMIN", "EDITOR", "APPROVER", "VIEWER"] as const;
export type RoleName = (typeof ROLES)[number];

export const ROLE_LABELS: Record<RoleName, string> = {
  ADMIN: "Administrador",
  EDITOR: "Editor",
  APPROVER: "Aprobador",
  VIEWER: "Solo lectura",
};

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  ADMIN: "Acceso total: equipo, cuentas conectadas y configuración.",
  EDITOR: "Crea y edita borradores de publicaciones.",
  APPROVER: "Aprueba publicaciones y ve las métricas.",
  VIEWER: "Solo puede ver cuentas y métricas.",
};

const ALL: readonly RoleName[] = ROLES;

/** Que roles tienen cada permiso. Es la unica fuente de verdad de autorizacion. */
const MATRIX = {
  "team.manage": ["ADMIN"],
  "audit.view": ["ADMIN"],
  "accounts.view": ALL,
  "accounts.manage": ["ADMIN"],
  "metrics.view": ALL,
  "brands.view": ALL,
  "brands.manage": ["ADMIN", "EDITOR"], // perfil de voz de cada marca
  "content.view": ALL,
  "content.create": ["ADMIN", "EDITOR"], // crear y editar borradores, generar con IA, enviar a revision
  "content.approve": ["ADMIN", "APPROVER"], // aprobar o rechazar
  "content.publish": ["ADMIN", "APPROVER"], // publicar ya, reprogramar y cancelar
  "ai.manage": ["ADMIN"], // claves y modelos de los motores de IA (Claude, GPT, Gemini)
} as const satisfies Record<string, readonly RoleName[]>;

export type Permission = keyof typeof MATRIX;

export function can(role: RoleName, permission: Permission): boolean {
  return (MATRIX[permission] as readonly RoleName[]).includes(role);
}

export function isRole(value: unknown): value is RoleName {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
