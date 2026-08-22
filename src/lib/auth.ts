import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins/magic-link";
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { magicLinkEmail } from "@/lib/magic-link-email";
import { seedTenant } from "@/lib/seed-tenant";
import { emailFrom } from "@/lib/email-from";

// Instanciar Resend solo al mandar el email, no al cargar el modulo: este archivo
// se importa desde paginas y route handlers que se evaluan en build time (next
// build recolecta datos de cada ruta), y el constructor de Resend revienta si
// RESEND_API_KEY todavia no esta configurado.
function getResend(): Resend {
  return new Resend(process.env.RESEND_API_KEY);
}

// Signup abierto: verificar el magic link (o registrarse con contraseña) de un
// email desconocido crea la cuenta con role "user" — dueño de su propio banco de
// señales. `input: false` impide que el cliente mande `role`, así que nadie se
// auto-asigna "platform_admin".
const MAGIC_LINK_EXPIRY_MINUTES = 10;

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: process.env.AUTH_SECRET,
  // Registro con contraseña además del magic link:
  // el hash vive en accounts.password, columna que better-auth ya pedía. El
  // signup sigue abierto igual que con el magic link; el rol lo fija el
  // additionalField de abajo (input: false), así que nadie se auto-asigna admin.
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  user: {
    // El cambio de email de /perfil NO usa el endpoint changeEmail de
    // better-auth: para cuentas con email verificado (magic link) exigiría un
    // flujo de verificación que no existe aquí. Se actualiza directo en la DB
    // (ver /api/perfil), con chequeo de unicidad propio.
    additionalFields: {
      role: {
        type: "string",
        required: true,
        defaultValue: "user",
        input: false,
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Cada usuario es un tenant: en cuanto existe la fila en `users` le
        // sembramos su cuota y su catálogo de categorías. Si el seed falla, el
        // registro NO se cae: la cuenta ya está creada y el seed es idempotente,
        // así que se puede reintentar; tumbar el signup por esto sería peor.
        after: async (user) => {
          try {
            await seedTenant(user.id);
          } catch (error) {
            console.error("[seed-tenant] falló al sembrar el tenant", user.id, error);
          }
        },
      },
    },
  },
  plugins: [
    magicLink({
      disableSignUp: false,
      expiresIn: MAGIC_LINK_EXPIRY_MINUTES * 60,
      async sendMagicLink({ email, url }) {
        // Solo decide el copy del correo (entrar vs crear cuenta); la respuesta
        // HTTP del formulario sigue siendo identica exista o no la cuenta.
        const existing = await prisma.user.findUnique({
          where: { email },
          select: { id: true },
        });
        const { subject, html, text } = magicLinkEmail({
          url,
          isNewAccount: existing === null,
          expiresInMinutes: MAGIC_LINK_EXPIRY_MINUTES,
        });
        await getResend().emails.send({
          from: emailFrom(),
          to: email,
          subject,
          html,
          text,
        });
      },
    }),
    nextCookies(),
  ],
});
