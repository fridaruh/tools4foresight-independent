import { requirePlatformAdminPage } from "@/lib/require-user";
import { withPlatformBypass } from "@/lib/tenant-db";
import { getAdminOverview } from "@/lib/admin-service";
import { isXCreditsDepleted } from "@/lib/platform-flags";
import { AdminTenantsTable, type AdminTenantDTO } from "@/components/AdminTenantsTable";
import { AdminXCreditsFlag } from "@/components/AdminXCreditsFlag";

export const dynamic = "force-dynamic";

/**
 * `/admin` (PLAN 5.1): panel de operación de la plataforma. Solo
 * `platform_admin` (Frida) — la guardia la pone `requirePlatformAdminPage`, no
 * el `ownerId` de nadie: esto es "operar la plataforma", no "ver mi banco".
 *
 * Todo sale de `withPlatformBypass`: es la única forma legítima de ver todos
 * los tenants a la vez (ver src/lib/tenant-db.ts).
 */
export default async function AdminPage() {
  await requirePlatformAdminPage();

  const [{ totals, tenants }, xCreditsDepleted] = await Promise.all([
    withPlatformBypass((tx) => getAdminOverview(tx)),
    isXCreditsDepleted(),
  ]);

  const tenantDtos: AdminTenantDTO[] = tenants.map((t) => ({
    userId: t.userId,
    name: t.name,
    email: t.email,
    role: t.role,
    xConnected: t.xConnected,
    xUsername: t.xUsername,
    itemsTotal: t.itemsTotal,
    itemsPublished: t.itemsPublished,
    lastJobRun: t.lastJobRun ? { ...t.lastJobRun, at: t.lastJobRun.at.toISOString() } : null,
    pipelineEnabled: t.pipelineEnabled,
    quota: t.quota,
    usage30d: t.usage30d,
  }));

  return (
    <div
      data-section="admin"
      className="mx-auto flex w-full max-w-[100rem] flex-1 flex-col gap-8 px-6 py-8 sm:px-10"
    >
      <header>
        <h1 className="section-title text-ink">Admin</h1>
        <p className="text-sm text-ink-subtle">
          Operación de la plataforma: tenants, uso, cuotas y el flag global de créditos de X.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="border border-hairline bg-surface-1 p-4">
          <p className="label-mono text-ink-tertiary">Tenants</p>
          <p className="mt-1 text-2xl font-medium tabular-nums text-ink">{totals.tenants}</p>
        </div>
        <div className="border border-hairline bg-surface-1 p-4">
          <p className="label-mono text-ink-tertiary">Activos 7d</p>
          <p className="mt-1 text-2xl font-medium tabular-nums text-ink">{totals.active7d}</p>
        </div>
        <div className="border border-hairline bg-surface-1 p-4">
          <p className="label-mono text-ink-tertiary">Páginas X hoy</p>
          <p className="mt-1 text-2xl font-medium tabular-nums text-ink">{totals.xPagesToday}</p>
        </div>
        <div className="border border-hairline bg-surface-1 p-4">
          <p className="label-mono text-ink-tertiary">Tokens OpenAI 30d</p>
          <p className="mt-1 text-2xl font-medium tabular-nums text-ink">
            {totals.openaiTokens30d.toLocaleString("es-MX")}
          </p>
        </div>
      </section>

      <AdminXCreditsFlag initialDepleted={xCreditsDepleted} />

      <section className="flex flex-col gap-3">
        <h2 className="section-heading text-ink">Tenants</h2>
        <p className="text-sm text-ink-subtle">
          Uso de los últimos 30 días por tipo de evento (x_page, ollama_call, openai_embed). Edita
          la cuota y guarda: aplica en la próxima corrida del pipeline.
        </p>
        <AdminTenantsTable tenants={tenantDtos} />
      </section>
    </div>
  );
}
