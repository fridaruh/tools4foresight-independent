import { describe, expect, it } from "vitest";
import {
  GUIDE_SECTIONS,
  MODULE_INTROS,
  TASK_FACTS,
  taskKind,
  taskModule,
} from "@/lib/onboarding/config";

describe("config del onboarding", () => {
  it("la guía tiene bienvenida + un tramo por módulo", () => {
    expect(GUIDE_SECTIONS).toHaveLength(1 + MODULE_INTROS.length);
    expect(GUIDE_SECTIONS[0].key).toBe("bienvenida");
    expect(GUIDE_SECTIONS.slice(1).map((s) => s.key)).toEqual(MODULE_INTROS.map((m) => m.key));
  });

  it("suma 13 tareas: el tour, seis introducciones y seis acciones", () => {
    const tasks = GUIDE_SECTIONS.flatMap((s) => s.tasks);
    expect(tasks).toHaveLength(13);
    expect(tasks.filter((t) => t.kind === "tour")).toHaveLength(1);
    expect(tasks.filter((t) => t.kind === "intro")).toHaveLength(6);
    expect(tasks.filter((t) => t.kind === "action")).toHaveLength(6);
  });

  it("cada módulo tiene ruta, CTA y al menos una acción", () => {
    for (const m of MODULE_INTROS) {
      expect(m.route.startsWith("/")).toBe(true);
      expect(m.cta.href.startsWith("/")).toBe(true);
      expect(m.cta.label.length).toBeGreaterThan(0);
      expect(m.actions.length).toBeGreaterThanOrEqual(1);
      expect(m.title).toMatch(/^Paso \d+ · /);
    }
  });

  it("los ids de tarea siguen la convención modulo:tipo", () => {
    for (const sec of GUIDE_SECTIONS) {
      for (const task of sec.tasks) {
        expect(taskModule(task.id)).toBe(sec.key);
        expect(taskKind(task.id)).toBe(task.kind);
      }
    }
  });

  it("las tareas de sección arrastran el href de su módulo", () => {
    for (const m of MODULE_INTROS) {
      const sec = GUIDE_SECTIONS.find((s) => s.key === m.key)!;
      expect(sec.tasks[0].href).toBe(m.route);
      for (const task of sec.tasks.slice(1)) expect(task.href).toBe(m.cta.href);
    }
  });

  it("TASK_FACTS solo tiene acciones verificables y ninguna manual", () => {
    expect(Object.keys(TASK_FACTS).sort()).toEqual([
      "analisis:action",
      "catalogo:action",
      "grafo:action",
      "sistema:action",
    ]);
    // Categorías y Horizontes no dejan rastro consultable: se marcan a mano.
    expect(TASK_FACTS["categorias:action"]).toBeUndefined();
    expect(TASK_FACTS["horizontes:action"]).toBeUndefined();
  });
});
