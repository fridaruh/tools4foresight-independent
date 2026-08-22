import Link from "next/link";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/PasswordAuthForms";
import { getEffectiveRole } from "@/lib/require-user";

export const metadata = { robots: { index: false, follow: false } };

// Registro con email + contraseña: la alternativa al magic link para quien
// prefiere una contraseña de siempre. El signup crea el tenant (seedTenant) y
// entra directo a su cockpit — no hay plan que elegir (ver src/lib/auth.ts).
export default async function RegistroPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  // "/" es el cockpit de catalogo de cada usuario (PLAN 4.1).
  const redirectTo = from && from.startsWith("/") ? from : "/";
  const loginHref = from && from.startsWith("/") ? `/login?from=${encodeURIComponent(from)}` : "/login";

  const role = await getEffectiveRole();
  if (role !== null) redirect("/");

  return (
    <div
      data-section="login"
      className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-8"
    >
      <header>
        <h1 className="section-title text-ink">Crear cuenta</h1>
        <p className="text-sm text-ink-subtle">
          Tu nombre, email y una contraseña. Entras directo a tu banco de señales.
        </p>
      </header>

      <RegisterForm redirectTo={redirectTo} />

      <p className="text-sm text-ink-subtle">
        ¿Ya tienes cuenta?{" "}
        <Link href={loginHref} className="underline underline-offset-2 hover:text-ink">
          Entra aquí
        </Link>
        .
      </p>
    </div>
  );
}
