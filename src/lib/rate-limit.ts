// Best-effort: cada instancia serverless tiene su propio Map, asi que esto no
// es un limite global estricto entre instancias/regiones. Frena fuerza bruta
// trivial sin depender de un store externo (Redis/Upstash) para un parche que
// muere en Fase 1.
const attempts = new Map<string, { count: number; resetAt: number }>();

const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export function requestIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
