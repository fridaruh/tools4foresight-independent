import type { OnboardingFacts } from "@/lib/onboarding/config";
import { EMPTY_FACTS } from "@/lib/onboarding/config";

export const USER_ID = "u1";
export const STORAGE_KEY = `individual_onboarding_v1_${USER_ID}`;

/** Estado de navegación que leen los mocks de `next/navigation`. */
export const nav = { pathname: "/", search: "" };

export function facts(partial: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return { ...EMPTY_FACTS, ...partial };
}

/** Deja el onboarding como si el usuario ya hubiera pasado por el tour. */
export function seedStorage(state: Record<string, unknown>) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ tourDone: false, seenIntros: [], doneTasks: [], guideOpen: true, ...state }),
  );
}

export function readStorage(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
}
