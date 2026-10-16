import Link from "next/link";
import { Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/dal";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";

export default async function DashboardPage() {
  const user = await requireUser();
  const canManageTeam = can(user.role, "team.manage");

  const [connectedAccounts, activeUsers, pendingInvites, metaConnected, otherAdsConnected, brandCount, postCount] = await Promise.all([
    db.socialAccount.count({ where: { status: "ACTIVE" } }),
    db.user.count({ where: { active: true } }),
    canManageTeam
      ? db.invitation.count({ where: { acceptedAt: null, expiresAt: { gt: new Date() } } })
      : Promise.resolve(null),
    db.socialAccount.count({ where: { platform: "META", status: "ACTIVE" } }),
    db.socialAccount.count({ where: { platform: { in: ["GOOGLE_ADS", "TIKTOK"] }, status: "ACTIVE" } }),
    db.brand.count(),
    db.post.count(),
  ]);

  const stats = [
    { label: "Cuentas conectadas", value: connectedAccounts, href: "/cuentas" },
    { label: "Personas en el equipo", value: activeUsers, href: canManageTeam ? "/equipo" : undefined },
    ...(pendingInvites !== null
      ? [{ label: "Invitaciones pendientes", value: pendingInvites, href: "/equipo" }]
      : []),
  ];

  const steps = [
    { title: "Crear la cuenta de administrador", done: true },
    {
      title: "Invitar al equipo",
      done: activeUsers > 1,
      href: canManageTeam ? "/equipo" : undefined,
    },
    {
      title: "Conectar Facebook, Instagram y Meta Ads",
      done: metaConnected > 0,
      href: canManageTeam ? "/cuentas" : undefined,
    },
    {
      title: "Conectar Google Ads o TikTok Ads (opcional)",
      done: otherAdsConnected > 0,
      href: canManageTeam ? "/cuentas" : undefined,
    },
    {
      title: "Definir el perfil de cada marca para la IA",
      done: brandCount > 0,
      href: can(user.role, "brands.manage") ? "/marcas" : undefined,
    },
    {
      title: "Crear la primera publicación",
      done: postCount > 0,
      href: can(user.role, "content.create") ? "/publicaciones/nueva" : undefined,
    },
  ];

  return (
    <>
      <PageHeader
        title={`Hola, ${user.name.split(" ")[0]}`}
        description="Resumen de tus cuentas y de tu equipo."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => {
          const body = (
            <Card className="p-5 transition-colors hover:border-primary/40">
              <p className="text-sm text-muted">{s.label}</p>
              <p className="mt-1 text-3xl font-semibold tabular-nums">{s.value}</p>
            </Card>
          );
          return s.href ? (
            <Link key={s.label} href={s.href}>
              {body}
            </Link>
          ) : (
            <div key={s.label}>{body}</div>
          );
        })}
      </div>

      <Card className="mt-6">
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-semibold">Primeros pasos</h2>
        </div>
        <ul className="divide-y divide-border">
          {steps.map((step) => (
            <li key={step.title} className="flex items-center gap-3 px-5 py-3 text-sm">
              <span
                aria-hidden="true"
                className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                  step.done
                    ? "border-success bg-success-bg text-success"
                    : "border-border text-transparent"
                }`}
              >
                ✓
              </span>
              <span className={step.done ? "text-muted line-through" : ""}>
                {step.href && !step.done ? (
                  <Link href={step.href} className="font-medium text-primary hover:underline">
                    {step.title}
                  </Link>
                ) : (
                  step.title
                )}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
