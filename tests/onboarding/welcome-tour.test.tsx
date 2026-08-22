import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingProvider } from "@/components/onboarding/onboarding-context";
import { WelcomeTour } from "@/components/onboarding/welcome-tour";
import { TOUR_STEPS } from "@/lib/onboarding/config";
import { facts, readStorage, seedStorage, USER_ID } from "./helpers";

// `vi.mock` tiene que estar en el archivo de test: se iza al principio del
// módulo, antes de los imports, y no funcionaría escondido en un helper.
vi.mock("next/navigation", async () => {
  const { nav } = await import("./helpers");
  return {
    usePathname: () => nav.pathname,
    useSearchParams: () => new URLSearchParams(nav.search),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  };
});

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function setup() {
  return render(
    <OnboardingProvider userId={USER_ID} facts={facts()}>
      <WelcomeTour />
    </OnboardingProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("WelcomeTour", () => {
  it("no pinta nada hasta que se leyó localStorage (anti-flash)", async () => {
    setup();
    // `ready` se resuelve en una microtask, así que en este punto todavía no.
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByRole("heading").textContent).toBe(TOUR_STEPS[0].title);
  });

  it('"Saltar por ahora" cierra el tour y lo deja marcado como hecho', async () => {
    setup();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    act(() => screen.getByText("Saltar por ahora").click());

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(readStorage().tourDone).toBe(true));
    // Saltarlo también deja la guía abierta: sin tour, la checklist es el mapa.
    expect(readStorage().guideOpen).toBe(true);
  });

  it("avanza paso a paso y termina en el último CTA", async () => {
    setup();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    for (let i = 0; i < TOUR_STEPS.length; i += 1) {
      expect(screen.getByRole("heading").textContent).toBe(TOUR_STEPS[i].title);
      act(() => screen.getByText(TOUR_STEPS[i].cta).click());
    }

    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(readStorage().tourDone).toBe(true));
  });

  it("no vuelve a aparecer si el tour ya se hizo", async () => {
    seedStorage({ tourDone: true });
    setup();
    await waitFor(() => expect(readStorage().tourDone).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
