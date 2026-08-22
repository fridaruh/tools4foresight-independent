import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSessionUser, requireSessionPage } from "@/lib/require-admin";
import { ProfileForms } from "@/components/ProfileForms";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

// Mi perfil: nombre, email y contraseña del usuario de la sesión. Llega aquí
// desde el círculo de cuenta de la nav.
export default async function PerfilPage() {
  await requireSessionPage();
  const user = await getSessionUser();

  // Cookie legacy de Fase 0: hay acceso pero no hay usuario que editar.
  if (!user) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-6 py-8">
        <h1 className="section-title text-ink">Mi perfil</h1>
        <p className="text-sm text-ink-subtle">
          Estás dentro con el acceso temporal de admin, que no tiene usuario detrás.{" "}
          <Link href="/login" className="underline underline-offset-2 hover:text-ink">
            Entra con tu cuenta
          </Link>{" "}
          para editar tu perfil.
        </p>
      </div>
    );
  }

  const credential = await prisma.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
    select: { id: true },
  });

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="section-title text-ink">Mi perfil</h1>
        <p className="text-sm text-ink-subtle">Tu cuenta en tools4foresight.</p>
      </header>

      <ProfileForms
        initialName={user.name}
        initialEmail={user.email}
        hasPassword={credential !== null}
      />
    </div>
  );
}
