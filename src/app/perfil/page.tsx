import { prisma } from "@/lib/prisma";
import { requireUserPage } from "@/lib/require-user";
import { ProfileForms } from "@/components/ProfileForms";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

// Mi perfil: nombre, email y contraseña del usuario de la sesión. Llega aquí
// desde el círculo de cuenta de la nav.
export default async function PerfilPage() {
  const user = await requireUserPage();

  const credential = await prisma.account.findFirst({
    where: { userId: user.userId, providerId: "credential" },
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
