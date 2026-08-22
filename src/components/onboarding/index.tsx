"use client";

import { Suspense } from "react";
import { WelcomeTour } from "./welcome-tour";
import { ModuleIntro } from "./module-intro";
import { GuideWidget } from "./guide-widget";

export { OnboardingProvider, useOnboarding, useOnboardingOptional } from "./onboarding-context";
export { GuideHelpButton } from "./guide-widget";

/**
 * Las tres capas del onboarding, montadas juntas al final del layout. No hay
 * ruta propia ni gate en el proxy: la app se renderiza normal y esto se
 * superpone, así que quien ya configuró todo nunca ve una pantalla de más.
 *
 * El orden importa: tour (z-70) tapa al intro (z-60) tapa al widget (z-50).
 *
 * `ModuleIntro` va en Suspense porque lee `useSearchParams`; el layout ya es
 * dinámico por `headers()`, pero el boundary lo deja a salvo de cualquier ruta
 * que en el futuro sí se prerenderice.
 */
export function Onboarding() {
  return (
    <>
      <WelcomeTour />
      <Suspense fallback={null}>
        <ModuleIntro />
      </Suspense>
      <GuideWidget />
    </>
  );
}
