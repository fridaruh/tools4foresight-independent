import Link from "next/link";
import { redirect } from "next/navigation";
import { MagicLinkForm } from "@/components/MagicLinkForm";
import { PasswordLoginForm } from "@/components/PasswordAuthForms";
import { getEffectiveRole } from "@/lib/require-user";

const ERROR_LABEL: Record<string, string> = {
  "1": "Password incorrecta.",
  rate_limited: "Demasiados intentos. Espera unos minutos.",
};

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
  // La home del member (tarjetas por categoria) es el destino por default:
  // mandar a "/" dejaba a los miembros en la landing publica despues de
  // autenticarse.
  const redirectTo = from && from.startsWith("/") ? from : "/categorias";

  // Con sesion activa no hay nada que pedir aqui: a su vista segun rol. (El proxy
  // no cubre /login, asi que el redirect vive en la propia pagina.)
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

      {/* Parche de Fase 0 mientras se confirma que el magic link llega: se retira
          en cuanto el envío por email quede verificado en producción. */}
      <details className="text-sm text-ink-subtle">
        <summary className="label-mono cursor-pointer text-ink-tertiary">
          Acceso admin (gate temporal de Fase 0)
        </summary>
        <form method="POST" action="/api/auth/login" className="mt-3 flex flex-col gap-3">
          <input type="hidden" name="from" value={redirectTo} />
          <input
            type="password"
            name="password"
            className="border border-hairline bg-surface-1 px-3 py-2 text-sm text-ink outline-none focus-visible:border-ink"
          />
          <button
            type="submit"
            className="label-mono border border-hairline bg-canvas px-3 py-2 text-ink hover:bg-surface-2"
          >
            Entrar
          </button>
          {error && !magicError && (
            <p className="text-xs text-danger">{ERROR_LABEL[error] ?? "Algo falló, intenta de nuevo."}</p>
          )}
        </form>
      </details>
    </div>
  );
}
