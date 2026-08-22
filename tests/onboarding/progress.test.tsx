import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OnboardingProvider, useOnboarding } from "@/components/onboarding/onboarding-context";
import { facts, USER_ID } from "./helpers";

/**
 * Sonda: expone el estado del provider como texto para poder afirmar sobre él
 * sin depender del markup del widget.
 */
function Probe() {
  const { ready, progress, isTaskDone, isTaskVerified, toggleTask, completeTour, markIntroSeen } =
    useOnboarding();
  return (
    <div>
      <span data-testid="ready">{String(ready)}</span>
      <span data-testid="progress">{`${progress.done}/${progress.total}`}</span>
      <span data-testid="x">{String(isTaskDone("sistema:action"))}</span>
      <span data-testid="grafo">{String(isTaskDone("grafo:action"))}</span>
      <span data-testid="cats">{String(isTaskDone("categorias:action"))}</span>
      <span data-testid="cats-verified">{String(isTaskVerified("categorias:action"))}</span>
      <span data-testid="x-verified">{String(isTaskVerified("sistema:action"))}</span>
      <span data-testid="intro">{String(isTaskDone("grafo:intro"))}</span>
      <span data-testid="tour">{String(isTaskDone("bienvenida:tour"))}</span>
      <button onClick={() => toggleTask("categorias:action")}>manual</button>
      <button onClick={() => toggleTask("sistema:action")}>verificada</button>
      <button onClick={completeTour}>tour</button>
      <button onClick={() => markIntroSeen("grafo")}>intro</button>
    </div>
  );
}

/** Texto de una sonda. */
function txt(id: string) {
  return screen.getByTestId(id).textContent;
}

function setup(f = facts()) {
  return render(
    <OnboardingProvider userId={USER_ID} facts={f}>
      <Probe />
    </OnboardingProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("isTaskDone", () => {
  it("sin facts ni estado, todo está pendiente", async () => {
    setup();
    await waitFor(() => expect(txt("ready")).toBe("true"));
    expect(txt("progress")).toBe("0/13");
  });

  it("las acciones con fact se dan por hechas desde los datos reales", async () => {
    setup(facts({ xConnected: true, itemCount: 3 }));
    await waitFor(() => expect(txt("ready")).toBe("true"));

    // sistema:action + catalogo:action
    expect(txt("progress")).toBe("2/13");
    expect(txt("x")).toBe("true");
    expect(txt("grafo")).toBe("false");
    expect(txt("x-verified")).toBe("true");
  });

  it("un conteo cuenta como hecho solo si es mayor que cero", async () => {
    setup(facts({ publishedCount: 0 }));
    await waitFor(() => expect(txt("ready")).toBe("true"));
    expect(txt("progress")).toBe("0/13");

    cleanup();
    setup(facts({ publishedCount: 1 }));
    await waitFor(() => expect(txt("ready")).toBe("true"));
    expect(txt("progress")).toBe("1/13");
  });

  it("las acciones manuales sí se marcan a mano, las verificadas no", async () => {
    setup();
    await waitFor(() => expect(txt("ready")).toBe("true"));

    act(() => screen.getByText("manual").click());
    expect(txt("cats")).toBe("true");
    expect(txt("cats-verified")).toBe("false");
    expect(txt("progress")).toBe("1/13");

    // Marcar a mano una tarea verificable no la mueve: manda la base.
    act(() => screen.getByText("verificada").click());
    expect(txt("x")).toBe("false");
    expect(txt("progress")).toBe("1/13");
  });

  it("tour e introducciones salen del estado local", async () => {
    setup();
    await waitFor(() => expect(txt("ready")).toBe("true"));

    act(() => screen.getByText("tour").click());
    expect(txt("tour")).toBe("true");

    act(() => screen.getByText("intro").click());
    expect(txt("intro")).toBe("true");
    expect(txt("progress")).toBe("2/13");
  });
});
