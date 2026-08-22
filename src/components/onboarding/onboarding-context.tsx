"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  EMPTY_FACTS,
  GUIDE_SECTIONS,
  TASK_FACTS,
  factSatisfied,
  taskKind,
  taskModule,
  type ModuleKey,
  type OnboardingFacts,
} from "@/lib/onboarding/config";

/**
 * Lo único que se persiste. Todo lo demás (qué modal está abierto, en qué paso
 * va el tour) es estado efímero del componente: si recargas a media guía,
 * vuelves a empezar ese modal, no toda la configuración.
 *
 * Ojo con lo que NO está aquí: el progreso de las acciones verificables. Eso
 * vive en la base y llega como `facts`; guardarlo en localStorage sería tener
 * dos verdades y que ganara la equivocada.
 */
type OnboardingState = {
  tourDone: boolean;
  seenIntros: ModuleKey[];
  doneTasks: string[];
  guideOpen: boolean;
};

const INITIAL: OnboardingState = {
  tourDone: false,
  seenIntros: [],
  doneTasks: [],
  guideOpen: false,
};

type OnboardingContextValue = {
  /** false hasta que se leyó localStorage. Nada del onboarding se pinta antes. */
  ready: boolean;
  state: OnboardingState;
  facts: OnboardingFacts;
  completeTour: () => void;
  markIntroSeen: (module: ModuleKey) => void;
  resetIntro: (module: ModuleKey) => void;
  toggleTask: (taskId: string) => void;
  openGuide: () => void;
  closeGuide: () => void;
  progress: { done: number; total: number };
  isTaskDone: (taskId: string) => boolean;
  /** true si la tarea la verifica la base y no se puede marcar a mano. */
  isTaskVerified: (taskId: string) => boolean;
};

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function OnboardingProvider({
  userId,
  facts = EMPTY_FACTS,
  children,
}: {
  userId: string;
  /** Estado real del tenant, leído en el layout. Ver src/lib/onboarding/facts.ts. */
  facts?: OnboardingFacts;
  children: React.ReactNode;
}) {
  const storageKey = `individual_onboarding_v1_${userId}`;
  const [state, setState] = useState<OnboardingState>(INITIAL);
  const [ready, setReady] = useState(false);
  // Guarda contra el efecto de escritura: sin esto, el primer render (con
  // INITIAL) pisaría en localStorage lo que todavía no se ha leído.
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Diferido a microtask para no disparar renders en cascada dentro del efecto.
    queueMicrotask(() => {
      if (cancelled) return;
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          setState({ ...INITIAL, ...JSON.parse(raw) });
        } else {
          // Primera visita: la guía arranca abierta, detrás del tour.
          setState({ ...INITIAL, guideOpen: true });
        }
      } catch {
        // Storage bloqueado (Safari privado, cookies de terceros): el
        // onboarding sigue funcionando, solo que en memoria.
        setState({ ...INITIAL, guideOpen: true });
      }
      loaded.current = true;
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Degradación a memoria; ver arriba.
    }
  }, [state, storageKey]);

  const completeTour = useCallback(() => {
    setState((s) => ({ ...s, tourDone: true, guideOpen: true }));
  }, []);

  const markIntroSeen = useCallback((module: ModuleKey) => {
    setState((s) =>
      s.seenIntros.includes(module) ? s : { ...s, seenIntros: [...s.seenIntros, module] },
    );
  }, []);

  /** Saca el intro de "vistos" para que el modal del módulo vuelva a aparecer. */
  const resetIntro = useCallback((module: ModuleKey) => {
    setState((s) =>
      s.seenIntros.includes(module)
        ? { ...s, seenIntros: s.seenIntros.filter((m) => m !== module) }
        : s,
    );
  }, []);

  const toggleTask = useCallback((taskId: string) => {
    setState((s) => ({
      ...s,
      doneTasks: s.doneTasks.includes(taskId)
        ? s.doneTasks.filter((t) => t !== taskId)
        : [...s.doneTasks, taskId],
    }));
  }, []);

  const openGuide = useCallback(() => setState((s) => ({ ...s, guideOpen: true })), []);
  const closeGuide = useCallback(() => setState((s) => ({ ...s, guideOpen: false })), []);

  const isTaskVerified = useCallback((taskId: string) => taskId in TASK_FACTS, []);

  const isTaskDone = useCallback(
    (taskId: string) => {
      switch (taskKind(taskId)) {
        case "tour":
          return state.tourDone;
        case "intro":
          return state.seenIntros.includes(taskModule(taskId) as ModuleKey);
        case "action": {
          // Primero la verdad de la base; el checkbox manual es el respaldo
          // para las acciones que no dejan rastro consultable.
          const fact = TASK_FACTS[taskId];
          if (fact) return factSatisfied(facts, fact);
          return state.doneTasks.includes(taskId);
        }
      }
    },
    [state, facts],
  );

  const progress = useMemo(() => {
    const all = GUIDE_SECTIONS.flatMap((sec) => sec.tasks);
    return { done: all.filter((t) => isTaskDone(t.id)).length, total: all.length };
  }, [isTaskDone]);

  const value = useMemo(
    () => ({
      ready,
      state,
      facts,
      completeTour,
      markIntroSeen,
      resetIntro,
      toggleTask,
      openGuide,
      closeGuide,
      progress,
      isTaskDone,
      isTaskVerified,
    }),
    [
      ready,
      state,
      facts,
      completeTour,
      markIntroSeen,
      resetIntro,
      toggleTask,
      openGuide,
      closeGuide,
      progress,
      isTaskDone,
      isTaskVerified,
    ],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding() {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding debe usarse dentro de OnboardingProvider");
  return ctx;
}

/**
 * Igual que `useOnboarding` pero devuelve null fuera del provider. Lo usa el
 * icono de ayuda de la nav, que se renderiza también en pantallas sin sesión
 * (la landing, /login) donde no hay onboarding montado.
 */
export function useOnboardingOptional() {
  return useContext(OnboardingContext);
}
