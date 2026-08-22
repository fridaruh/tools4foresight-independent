import Link from "next/link";
import { redirect } from "next/navigation";
import { RegisterForm } from "@/components/PasswordAuthForms";
import { getEffectiveRole } from "@/lib/require-user";

export const metadata = { robots: { index: false, follow: false } };

// Registro con email + contraseña (Fase 1.5): la alternativa al magic link
// para quien prefiere una contraseña de siempre. Mismo signup abierto y mismo
// rol member por default que el magic link (ver src/lib/auth.ts).
export default async function RegistroPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;
  // Destino por default: /suscripcion. Una cuenta nueva no tiene acceso hasta
  // suscribirse, asi que mandarla a /categorias solo añadia un rebote (el gate
  // la traeria aqui igual). Si viene de la landing, `from` ya trae el plan.
  const redirectTo = from && from.startsWith("/") ? from : "/suscripcion";
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
          Paso 1 de 2: tu email y una contraseña. En el siguiente paso eliges el plan y entras
          al banco.
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
