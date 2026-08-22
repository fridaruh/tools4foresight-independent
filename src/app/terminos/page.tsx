export const metadata = { title: "Términos de servicio — tools4foresight" };

export default function TerminosPage() {
  return (
    <div
      data-section="terminos"
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-8 sm:px-10"
    >
      <header>
        <h1 className="section-title text-ink">Términos de servicio</h1>
        <p className="text-sm text-ink-subtle">
          Última actualización: [PLACEHOLDER: fecha de publicación].
        </p>
      </header>

      <div className="flex flex-col gap-5 text-sm leading-relaxed text-ink">
        <section>
          <h2 className="section-heading mb-1 text-ink">1. Quiénes somos</h2>
          <p>
            tools4foresight es un servicio de membresía operado por{" "}
            <strong>[PLACEHOLDER: razón social / nombre de la persona titular]</strong>, con domicilio
            en <strong>[PLACEHOLDER: dirección fiscal]</strong>. Puedes contactarnos en{" "}
            <strong>[PLACEHOLDER: email de soporte]</strong>.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">2. Qué es el servicio</h2>
          <p>
            tools4foresight da acceso a un banco curado de señales — contenido que la persona titular
            marca como relevante en X (Twitter), junto con su análisis de impacto y contexto — a través
            de una suscripción de pago.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">3. Cuentas</h2>
          <p>
            El acceso es individual e intransferible: no compartas tu sesión ni tu enlace de acceso. Nos
            reservamos el derecho de suspender cuentas que compartan credenciales o usen el servicio de
            forma automatizada no autorizada.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">4. Precio, cobro y cancelación</h2>
          <p>
            El precio de la suscripción es de $15 USD al mes (o el precio vigente que se muestre al
            momento de suscribirte), con periodo de prueba{" "}
            <strong>[PLACEHOLDER: duración exacta del trial]</strong> que requiere método de pago
            registrado. Puedes cancelar en cualquier momento desde tu perfil; el acceso continúa hasta el
            final del periodo ya pagado. [PLACEHOLDER: política de reembolsos, si aplica].
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">5. Propiedad del contenido</h2>
          <p>
            El análisis, la categorización y las notas que acompañan cada señal son propiedad de
            tools4foresight. Los enlaces a publicaciones originales de X apuntan a contenido de terceros
            sobre el que no reclamamos derechos; su uso se rige por los términos de X Corp.
          </p>
          <p className="mt-2">
            No está permitido redistribuir, revender o republicar el contenido del banco de señales fuera
            de tu propio uso personal como suscriptor.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">6. Disponibilidad del servicio</h2>
          <p>
            Hacemos un esfuerzo razonable por mantener el servicio disponible, pero no garantizamos
            operación ininterrumpida. El banco se actualiza según el criterio editorial de la persona
            titular; no garantizamos una frecuencia mínima de publicación.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">7. Cambios a estos términos</h2>
          <p>
            Podemos actualizar estos términos; los cambios relevantes se anunciarán por el mismo correo
            de la cuenta o dentro del sitio. Seguir usando el servicio después de un cambio implica
            aceptarlo.
          </p>
        </section>

        <section>
          <h2 className="section-heading mb-1 text-ink">8. Ley aplicable</h2>
          <p>
            Estos términos se rigen por las leyes de{" "}
            <strong>[PLACEHOLDER: jurisdicción — p.ej. México / el estado donde esté constituido el negocio]</strong>.
          </p>
        </section>
      </div>
    </div>
  );
}
