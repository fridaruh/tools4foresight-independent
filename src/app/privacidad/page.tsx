export const metadata = { title: "Aviso de privacidad — tools4foresight" };

export default function PrivacidadPage() {
  return (
    <div
      data-section="privacidad"
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-8 sm:px-10"
    >
      <header>
        <h1 className="section-title text-ink">Aviso de privacidad</h1>
        <p className="text-sm text-ink-subtle">
          Última actualización: [PLACEHOLDER: fecha de publicación].
        </p>
      </header>

      <div className="flex flex-col gap-5 text-sm leading-relaxed text-ink">
        <section>
          <h2 className="section-heading mb-1 text-ink">1. Quién trata tus datos</h2>
          <p>
            <strong>[PLACEHOLDER: razón social / nombre de la persona titular]</strong> es responsable
            del tratamiento de tus datos personales al usar tools4foresight. Contacto:{" "}
            <strong>[PLACEHOLDER: email de contacto de privacidad]</strong>.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">2. Qué datos recopilamos</h2>
          <ul className="ml-4 list-disc space-y-1">
            <li>Correo electrónico, para crear tu cuenta y mandarte el enlace de acceso (magic link).</li>
            <li>
              Datos de pago y facturación, procesados directamente por nuestro procesador de pagos —
              nosotros no almacenamos el número completo de tu tarjeta.{" "}
              <strong>[PLACEHOLDER: nombrar al procesador de pago, p.ej. Stripe, cuando esté integrado]</strong>.
            </li>
            <li>Registros técnicos básicos (dirección IP, user agent) por seguridad y prevención de abuso.</li>
            <li>Qué señales ves o marcas, para mejorar la curaduría y medir qué contenido es útil.</li>
          </ul>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">3. Para qué usamos tus datos</h2>
          <p>
            Para darte acceso al servicio, procesar tu suscripción, mandarte el digest o avisos que
            elijas recibir, dar soporte, y cumplir obligaciones legales o fiscales aplicables.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">4. Con quién compartimos tus datos</h2>
          <p>
            Con proveedores que nos ayudan a operar el servicio — envío de correo (Resend), cobro de
            suscripciones (<strong>[PLACEHOLDER: Stripe u otro, cuando esté integrado]</strong>),
            hospedaje (Vercel) — bajo sus propios términos de confidencialidad. No vendemos tus datos a
            terceros.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">5. Cuánto tiempo los conservamos</h2>
          <p>
            Mientras tu cuenta esté activa y por el periodo adicional que exija la ley aplicable
            (p.ej. registros fiscales). Puedes pedir que borremos tu cuenta y datos asociados escribiendo
            a <strong>[PLACEHOLDER: email de contacto de privacidad]</strong>.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">6. Tus derechos</h2>
          <p>
            Puedes pedir acceso, corrección, cancelación u oposición sobre tus datos personales (derechos
            ARCO o los que correspondan según tu jurisdicción), y retirar tu consentimiento en cualquier
            momento, escribiendo a <strong>[PLACEHOLDER: email de contacto de privacidad]</strong>.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">7. Cambios a este aviso</h2>
          <p>
            Si actualizamos este aviso de forma relevante, te lo notificaremos por correo o dentro del
            sitio antes de que entre en vigor.
          </p>
        </section>
      </div>
    </div>
  );
}
