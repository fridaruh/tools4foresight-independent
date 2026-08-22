import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins/magic-link";
import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { magicLinkEmail } from "@/lib/magic-link-email";
import { emailFrom } from "@/lib/email-from";
import { sendOnboardingStep } from "@/lib/jobs/onboarding";

// Instanciar Resend solo al mandar el email, no al cargar el modulo: este archivo
// se importa desde paginas y route handlers que se evaluan en build time (next
// build recolecta datos de cada ruta), y el constructor de Resend revienta si
// RESEND_API_KEY todavia no esta configurado.
function getResend(): Resend {
  return new Resend(process.env.RESEND_API_KEY);
}

// Signup abierto: verificar el magic link de un email desconocido crea la
// cuenta con role "member" (defaultValue del additionalField; `input: false`
// impide que el cliente mande role, asi que nadie se auto-asigna admin).
// Mientras no exista Fase 4 (Stripe), member = acceso completo a /senales.
const MAGIC_LINK_EXPIRY_MINUTES = 10;

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: process.env.AUTH_SECRET,
  // Registro con contraseña además del magic link (pedido de Frida, 2026-08-17):
  // el hash vive en accounts.password, columna que better-auth ya pedía. El
  // signup sigue abierto igual que con el magic link; el rol lo fija el
  // additionalField de abajo (input: false), así que nadie se auto-asigna admin.
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  databaseHooks: {
    user: {
      create: {
        // Correo de bienvenida al crear la cuenta (magic link o contraseña,
        // ambos pasan por aqui). Un fallo de Resend nunca debe romper el
        // signup: se traga y el usuario simplemente no recibe la bienvenida.
        after: async (user) => {
          try {
            await sendOnboardingStep(
              { id: user.id, email: user.email, name: user.name },
              "welcome",
              {},
            );
          } catch (error) {
            console.error("No se pudo mandar el correo de bienvenida:", error);
          }
        },
      },
    },
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
        defaultValue: "member",
        input: false,
      },
      stripeCustomerId: {
        type: "string",
        required: false,
        input: false,
      },
      // Espejo del estado de la suscripcion de Stripe (lo escribe el webhook).
      // Declarado aqui para que viaje en session.user y el gate de acceso no
      // tenga que hacer una query extra por request (src/lib/require-admin.ts).
      subscriptionStatus: {
        type: "string",
        required: false,
        input: false,
      },
      subscriptionId: {
        type: "string",
        required: false,
        input: false,
      },
      subscriptionPeriodEnd: {
        type: "date",
        required: false,
        input: false,
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
