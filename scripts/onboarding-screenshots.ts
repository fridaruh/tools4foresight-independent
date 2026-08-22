/**
 * Las ocho capturas del onboarding (Onboarding.md §10, receta 2–5).
 *
 *   npm run seed:demo        # primero: el tenant de demo con datos creíbles
 *   npm run shots:onboarding # esto: levanta la app, entra y fotografía
 *
 * Qué produce en `public/onboarding/`:
 *   catalogo.png · analisis.png · grafo.png · horizontes.png · categorias.png
 *   sistema.png  · tour-guia.png · tour-nav.png
 *
 * Cómo:
 *   1. Levanta `next dev -p 3123` como hijo contra la MISMA base que la app
 *      (reusa el patrón de scripts/qa-ui-smoke.ts) y espera a que imprima Ready.
 *   2. Entra con POST a /api/auth/sign-in/email con el usuario de demo y se queda
 *      con la cookie de sesión y con el `user.id` — que hace falta para la clave
 *      de localStorage del onboarding, que lleva el id dentro.
 *   3. Precalienta cada ruta con un `fetch` normal. En dev, Next compila la ruta
 *      la primera vez que se pide, y eso puede tardar más que el timeout de
 *      navegación: precalentar deja los 30 s de la captura para renderizar, no
 *      para compilar.
 *   4. Abre Chromium a 1440×900 con `deviceScaleFactor 2` (se fotografía al doble
 *      y se reduce después: el texto queda nítido) y, con `addInitScript`, deja
 *      el onboarding marcado como visto ANTES de que cargue cada página. Sin eso
 *      el modal de introducción del módulo saldría tapando justo lo que se quiere
 *      enseñar.
 *   5. Recorta con `clip` desde el borde superior, ~820 px de alto: entra la nav
 *      —que da contexto de dónde está uno— y el primer tramo útil de la pantalla.
 *   6. Para tour-guia/tour-nav abre un segundo contexto con `guideOpen: true` y
 *      recorta el nodo `[data-onboarding="guide"]` (con 24 px de margen) y el
 *      `[data-onboarding="nav"]`.
 *   7. Optimiza con sharp: reduce a 1440 px de ancho y cuantiza la paleta hasta
 *      quedar por debajo de 250 KB.
 *
 * El servidor de dev se mata en el `finally`, pase lo que pase.
 */
import "dotenv/config";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import sharp from "sharp";

const PORT = 3123;
const BASE_URL = `http://localhost:${PORT}`;
const READY_TIMEOUT_MS = 120_000;
/** Tope por navegación una vez precalentada la ruta. */
const NAV_TIMEOUT_MS = 30_000;
/** Tope del precalentamiento: aquí sí se paga la compilación de dev. */
const WARMUP_TIMEOUT_MS = 180_000;

const VIEWPORT = { width: 1440, height: 900 };
/** Alto útil de la captura de módulo: nav + el primer tramo de la pantalla. */
const CLIP_HEIGHT = 820;
/** Ancho final del PNG. Onboarding.md pide 1200–1600 px. */
const OUTPUT_WIDTH = 1440;
const MAX_BYTES = 250 * 1024;

const OUT_DIR = path.join(process.cwd(), "public", "onboarding");

const DEMO_EMAIL = "demo@individual.local";
const DEMO_PASSWORD = "DemoIndividual2026!";

/** Las seis pantallas, en el orden del ciclo de vida de una señal. */
const MODULE_SHOTS: { route: string; file: string; settleMs?: number; prepare?: (page: Page) => Promise<void> }[] = [
  {
    route: "/",
    file: "catalogo.png",
    // En tarjetas, las señales sin imagen OG muestran un bloque "SIN IMAGEN" que
    // no enseña nada; la lista muestra texto, autor, categoría y fecha.
    prepare: async (page) => {
      await page.getByRole("button", { name: /^lista$/i }).click();
      await page.waitForTimeout(300);
    },
  },
  { route: "/enrich", file: "analisis.png" },
  // El force-graph anima el layout: sin margen, la captura sale con los nodos
  // todavía volando hacia su sitio.
  { route: "/grafo", file: "grafo.png", settleMs: 3_000 },
  { route: "/horizontes", file: "horizontes.png", settleMs: 800 },
  { route: "/categorias", file: "categorias.png" },
  { route: "/conexion", file: "sistema.png" },
];

const ALL_MODULES = ["sistema", "catalogo", "categorias", "analisis", "grafo", "horizontes"];

// ---------------------------------------------------------------------------
// next dev
// ---------------------------------------------------------------------------

type DevChild = ChildProcessByStdio<null, Readable, Readable>;

function waitForReady(child: DevChild): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`next dev no imprimió "Ready" en ${READY_TIMEOUT_MS}ms.\n${output}`));
    }, READY_TIMEOUT_MS);

    function onData(chunk: Buffer) {
      const text = chunk.toString("utf8");
      output += text;
      process.stdout.write(`[next dev] ${text}`);
      if (/Ready in/i.test(text) || /^- Ready/im.test(text)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[next dev:stderr] ${chunk.toString("utf8")}`);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`next dev salió antes de estar listo (code ${code})`));
    });
  });
}

// ---------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------

type Session = { cookies: { name: string; value: string }[]; userId: string };

/**
 * Entra con el usuario de demo por el endpoint de better-auth. Se queda con las
 * cookies (que se inyectan en el contexto de Playwright) y con el id del usuario,
 * que es parte de la clave de localStorage del onboarding.
 */
async function signIn(): Promise<Session> {
  const response = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    // better-auth exige un Origin explícito (protección CSRF): un `fetch` de
    // Node no lo manda solo y el endpoint responde 403 "Missing or null Origin".
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });

  const body = (await response.json()) as { user?: { id?: string }; message?: string };
  if (!response.ok || !body.user?.id) {
    throw new Error(
      `No se pudo entrar como ${DEMO_EMAIL} (status ${response.status}: ${body.message ?? "sin mensaje"}). ` +
        "¿Corriste `npm run seed:demo`?",
    );
  }

  const cookies = response.headers
    .getSetCookie()
    .map((raw) => {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() };
    })
    .filter((c) => c.name.length > 0 && c.value.length > 0);

  if (cookies.length === 0) throw new Error("El login no devolvió ninguna cookie de sesión");

  return { cookies, userId: body.user.id };
}

function cookieHeader(session: Session): string {
  return session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Pide cada ruta por HTTP antes de abrir el navegador. En `next dev` la primera
 * petición a una ruta la compila, y eso puede tardar más de lo que dura el
 * timeout de navegación de Playwright.
 */
async function warmup(session: Session): Promise<void> {
  for (const { route } of MODULE_SHOTS) {
    const started = Date.now();
    const response = await fetch(`${BASE_URL}${route}`, {
      headers: { cookie: cookieHeader(session) },
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
    });
    await response.text();
    console.log(`[warmup] ${route} -> ${response.status} (${Date.now() - started}ms)`);
    if (response.status !== 200) {
      throw new Error(`${route} respondió ${response.status} con la sesión de demo`);
    }
  }
}

// ---------------------------------------------------------------------------
// Contexto del navegador
// ---------------------------------------------------------------------------

/**
 * Un contexto con la sesión puesta y el estado del onboarding ya escrito en
 * localStorage. `addInitScript` corre antes que el JS de la página en CADA
 * navegación, así que el provider lee un estado "todo visto" y no dispara ni el
 * tour ni los modales de módulo — que es justo lo que taparía la captura.
 */
async function makeContext(
  browser: Browser,
  session: Session,
  guideOpen: boolean,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    colorScheme: "light",
    // Sin esto la animación del force-graph y las transiciones de CSS meten
    // fotogramas intermedios en la captura.
    reducedMotion: "reduce",
  });

  await context.addCookies(
    session.cookies.map((c) => ({ ...c, domain: "localhost", path: "/" })),
  );

  const storageKey = `individual_onboarding_v1_${session.userId}`;
  const state = {
    tourDone: true,
    seenIntros: ALL_MODULES,
    doneTasks: [] as string[],
    guideOpen,
  };
  await context.addInitScript(
    ([key, value]: [string, string]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Storage bloqueado: el onboarding degrada a memoria y volverían los
        // modales. No hay nada que hacer desde aquí, se ve en la captura.
      }
    },
    [storageKey, JSON.stringify(state)] as [string, string],
  );

  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  context.setDefaultTimeout(NAV_TIMEOUT_MS);
  return context;
}

async function goto(page: Page, route: string, settleMs = 400): Promise<void> {
  await page.goto(`${BASE_URL}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });
  // El layout es server component pero las tablas y el grafo hidratan en cliente.
  await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(settleMs);
}

// ---------------------------------------------------------------------------
// Optimización
// ---------------------------------------------------------------------------

/**
 * Reduce a `OUTPUT_WIDTH` y cuantiza la paleta hasta bajar de 250 KB. Se prueba
 * con menos colores en cada vuelta en vez de bajar la resolución: en una captura
 * de UI el texto es lo primero que se pierde al reescalar, y los colores planos
 * del diseño aguantan bien una paleta corta.
 */
async function optimize(buffer: Buffer, file: string): Promise<number> {
  const base = sharp(buffer).resize({ width: OUTPUT_WIDTH, withoutEnlargement: true });
  const target = path.join(OUT_DIR, file);

  for (const colours of [256, 192, 128, 96, 64, 48, 32]) {
    const out = await base
      .clone()
      .png({ palette: true, colours, compressionLevel: 9, effort: 10, dither: 0.5 })
      .toBuffer();
    if (out.byteLength <= MAX_BYTES || colours === 32) {
      await writeFile(target, out);
      return out.byteLength;
    }
  }
  /* istanbul ignore next — el bucle siempre escribe */
  throw new Error(`No se pudo optimizar ${file}`);
}

async function save(buffer: Buffer, file: string): Promise<void> {
  const bytes = await optimize(buffer, file);
  const kb = (bytes / 1024).toFixed(0);
  console.log(`  ✓ ${file.padEnd(16)} ${kb.padStart(4)} KB${bytes > MAX_BYTES ? "  (¡>250 KB!)" : ""}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  console.log(`Arrancando "next dev -p ${PORT}"…`);
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let browser: Browser | null = null;

  try {
    await waitForReady(child);
    console.log("next dev listo.\n");

    const session = await signIn();
    console.log(`Sesión de demo lista (userId ${session.userId}).\n`);

    await warmup(session);
    console.log("");

    browser = await chromium.launch();

    // ── Las seis pantallas ───────────────────────────────────────────────────
    const modules = await makeContext(browser, session, false);
    const page = await modules.newPage();

    console.log("Capturas de módulo:");
    for (const shot of MODULE_SHOTS) {
      await goto(page, shot.route, shot.settleMs);
      if (shot.prepare) await shot.prepare(page);
      const buffer = await page.screenshot({
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: CLIP_HEIGHT },
      });
      await save(buffer, shot.file);
    }
    await modules.close();

    // ── La guía y la nav (pasos 3 y 4 del tour) ──────────────────────────────
    const guide = await makeContext(browser, session, true);
    const guidePage = await guide.newPage();
    await goto(guidePage, "/", 900);

    console.log("\nCapturas del tour:");

    const widget = guidePage.locator('[data-onboarding="guide"]');
    await widget.waitFor({ state: "visible", timeout: NAV_TIMEOUT_MS });
    const widgetBox = await widget.boundingBox();
    if (!widgetBox) throw new Error('No se pudo medir [data-onboarding="guide"]');
    await save(
      await guidePage.screenshot({ clip: pad(widgetBox, 24) }),
      "tour-guia.png",
    );

    const nav = guidePage.locator('[data-onboarding="nav"]');
    await nav.waitFor({ state: "visible", timeout: NAV_TIMEOUT_MS });
    const navBox = await nav.boundingBox();
    if (!navBox) throw new Error('No se pudo medir [data-onboarding="nav"]');
    // La nav ya ocupa el ancho completo: solo se le deja aire abajo para que se
    // vea el borde y un asomo de la pantalla, que es lo que da contexto.
    await save(
      await guidePage.screenshot({
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.ceil(navBox.height) + 20 },
      }),
      "tour-nav.png",
    );

    await guide.close();

    console.log(`\nOK — 8 capturas en ${path.relative(process.cwd(), OUT_DIR)}/`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    console.log("\nMatando next dev…");
    child.kill("SIGTERM");
    // Turbopack deja hijos colgando del proceso padre; un SIGKILL de respaldo
    // evita que el script se quede esperando.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (!child.killed) child.kill("SIGKILL");
  }
}

/** Caja con margen, recortada al viewport (un clip fuera de pantalla revienta). */
function pad(
  box: { x: number; y: number; width: number; height: number },
  margin: number,
): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.floor(box.x - margin));
  const y = Math.max(0, Math.floor(box.y - margin));
  return {
    x,
    y,
    width: Math.min(VIEWPORT.width - x, Math.ceil(box.width + margin * 2)),
    height: Math.min(VIEWPORT.height - y, Math.ceil(box.height + margin * 2)),
  };
}

main()
  .then(async () => {
    // Un aviso tardío vale más que un README: si una captura se pasó de peso, la
    // app la sirve igual pero el modal tarda en pintarse.
    for (const { file } of MODULE_SHOTS) {
      const { size } = await stat(path.join(OUT_DIR, file));
      if (size > MAX_BYTES) console.warn(`AVISO: ${file} pesa ${(size / 1024).toFixed(0)} KB`);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
