import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingProvider } from "@/components/onboarding/onboarding-context";
import { ModuleIntro } from "@/components/onboarding/module-intro";
import { facts, nav, readStorage, seedStorage, USER_ID } from "./helpers";

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
      <ModuleIntro />
    </OnboardingProvider>,
  );
}

/** Espera a que el provider termine de hidratarse (`ready`). */
async function settle() {
  await waitFor(() => expect(readStorage().guideOpen).toBe(true));
}

beforeEach(() => {
  localStorage.clear();
  nav.pathname = "/";
  nav.search = "";
});
afterEach(cleanup);

describe("ModuleIntro", () => {
  it("no aparece antes de terminar el tour", async () => {
    seedStorage({ tourDone: false });
    nav.pathname = "/conexion";
    setup();
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("aparece en la raíz exacta del módulo, ya hecho el tour", async () => {
    seedStorage({ tourDone: true });
    nav.pathname = "/conexion";
    setup();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByRole("heading").textContent).toBe("Paso 1 · Sistema");
  });

  it("no aparece con query params: quien filtra ya no necesita la intro", async () => {
    seedStorage({ tourDone: true });
    nav.pathname = "/conexion";
    nav.search = "?tab=cuotas";
    setup();
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("no aparece en una subpágina del módulo", async () => {
    seedStorage({ tourDone: true });
    nav.pathname = "/conexion/callback";
    setup();
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("no vuelve a aparecer una vez visto", async () => {
    seedStorage({ tourDone: true, seenIntros: ["sistema"] });
    nav.pathname = "/conexion";
    setup();
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it('"Entendido" lo marca como visto y lo cierra', async () => {
    seedStorage({ tourDone: true });
    nav.pathname = "/grafo";
    setup();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    screen.getByText("Entendido").click();

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(readStorage().seenIntros).toEqual(["grafo"]);
  });
});
