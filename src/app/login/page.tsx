import Link from "next/link";
import { redirect } from "next/navigation";
import { MagicLinkForm } from "@/components/MagicLinkForm";
import { PasswordLoginForm } from "@/components/PasswordAuthForms";
import { getEffectiveRole } from "@/lib/require-user";

// Adonde redirige el verify del magic link cuando el token no sirve (ver
// errorCallbackURL en MagicLinkForm). Sin esto el error caia en "/" y la landing
// lo ignoraba: parecia que el login "no hacia nada".
const MAGIC_ERROR_LABEL: Record<string, string> = {
  INVALID_TOKEN: "Ese link ya se usó o expiró (dura 10 minutos). Pide uno nuevo.",
  EXPIRED_TOKEN: "Ese link ya expiró (dura 10 minutos). Pide uno nuevo.",
  failed_to_create_session: "No se pudo crear la sesión. Intenta de nuevo.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; from?: string }>;
}) {
  const { error, from } = await searchParams;
  // "/" es el cockpit de catalogo de cada usuario (PLAN 4.1): mandar ahi por
  // default, o de vuelta a donde el proxy interrumpio (`from`).
  const redirectTo = from && from.startsWith("/") ? from : "/";

  // Con sesion activa no hay nada que pedir aqui. (El proxy no cubre /login,
  // asi que el redirect vive en la propia pagina.)
  const role = await getEffectiveRole();
  if (role !== null) redirect("/");

  const magicError = error ? MAGIC_ERROR_LABEL[error] : undefined;

  return (
    <div
      data-section="login"
      className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-6 py-8"
    >
      <header>
        <h1 className="section-title text-ink">Acceso</h1>
        <p className="text-sm text-ink-subtle">Entra con tu email y contraseña.</p>
      </header>

      {magicError && <p className="text-sm text-danger">{magicError}</p>}

      <PasswordLoginForm redirectTo={redirectTo} />

      <p className="text-sm text-ink-subtle">
        ¿No tienes cuenta?{" "}
        <Link
          href={from && from.startsWith("/") ? `/registro?from=${encodeURIComponent(from)}` : "/registro"}
          className="underline underline-offset-2 hover:text-ink"
        >
          Regístrate aquí
        </Link>
        .
      </p>

      {/* El magic link sigue disponible para quien ya entraba así (o no quiere
          contraseña): si el email no tiene cuenta, verificar el link la crea. */}
      <details className="text-sm text-ink-subtle">
        <summary className="label-mono cursor-pointer text-ink-tertiary">
          Prefiero un link por email (sin contraseña)
        </summary>
        <div className="mt-3">
          <MagicLinkForm redirectTo={redirectTo} />
        </div>
      </details>
    </div>
  );
}
