import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdminApi } from "@/lib/require-user";
import { withPlatformBypass } from "@/lib/tenant-db";
import { AdminServiceError, parseTenantQuotaPatch, updateTenantQuota } from "@/lib/admin-service";

/**
 * `PATCH /api/admin/tenants/[id]` (PLAN 5.1): edita la `UserQuota` de un tenant
 * desde el panel de plataforma. Solo `platform_admin`; corre con
 * `withPlatformBypass` porque editar la cuota de OTRO tenant es, por
 * definición, cross-tenant — nunca pasa por `withOwner`.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requirePlatformAdminApi();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const body = await request.json().catch(() => null);

  try {
    const patch = parseTenantQuotaPatch(body);
    const quota = await withPlatformBypass((tx) => updateTenantQuota(tx, id, patch));
    return NextResponse.json({ ok: true, quota });
  } catch (error) {
    if (error instanceof AdminServiceError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    throw error;
  }
}
