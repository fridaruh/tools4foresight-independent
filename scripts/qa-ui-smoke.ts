/**
 * QA de humo de la UI (Fase 4, criterio de aceptación 4.1/4.2/4.7).
 *
 *   npm run qa:ui
 *
 * Levanta `next dev -p 3123` como proceso hijo contra la DB real (.env.local),
 * espera a que imprima "Ready" y hace cuatro peticiones sin cookie de sesión:
 *
 *   - GET  /                         -> 200, contiene "Tools 4 Foresight"
 *     (landing pública o cockpit, según haya sesión — sin cookie es la landing).
 *   - GET  /conexion                 -> 307 a /login (el proxy corta antes de
 *     llegar a la página: ver src/proxy.ts).
 *   - GET  /api/status                -> 401 (el proxy corta `/api/*` sin sesión).
 *   - POST /api/settings/anthropic    -> 401 (idem).
 *
 * No toca la DB directamente: todo pasa por HTTP contra el server real, así que
 * también sirve como smoke test de que `next build`/`next dev` arrancan sin
 * romperse con el schema y las env vars actuales. Al final mata el proceso
 * hijo pase lo que pase.
 */
import "dotenv/config";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

const PORT = 3123;
const BASE_URL = `http://localhost:${PORT}`;
const READY_TIMEOUT_MS = 60_000;

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type DevChild = ChildProcessByStdio<null, Readable, Readable>;

function waitForReady(child: DevChild): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`next dev no imprimió "Ready" en ${READY_TIMEOUT_MS}ms.\nSalida:\n${output}`));
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

async function main() {
  console.log(`Arrancando "next dev -p ${PORT}"…`);
  const child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  try {
    await waitForReady(child);
    console.log("next dev listo. Corriendo checks…\n");

    // GET / sin sesión -> landing pública (200, con el nombre del producto).
    const root = await fetch(`${BASE_URL}/`);
    const rootBody = await root.text();
    check("GET / -> 200", root.status === 200, `status=${root.status}`);
    check("GET / contiene 'Tools 4 Foresight'", rootBody.includes("Tools 4 Foresight"));

    // GET /conexion sin sesión -> el proxy redirige a /login antes de tocar la
    // página (307, no sigue el redirect para poder inspeccionar el código).
    const conexion = await fetch(`${BASE_URL}/conexion`, { redirect: "manual" });
    check("GET /conexion sin sesión -> 307", conexion.status === 307, `status=${conexion.status}`);
    const conexionLocation = conexion.headers.get("location") ?? "";
    check(
      "GET /conexion sin sesión -> redirige a /login",
      conexionLocation.includes("/login"),
      `location=${conexionLocation}`,
    );

    // GET /api/status sin sesión -> 401 (el proxy corta cualquier /api/* sin
    // cookie de sesión, ver src/proxy.ts).
    const status = await fetch(`${BASE_URL}/api/status`);
    check("GET /api/status sin sesión -> 401", status.status === 401, `status=${status.status}`);

    // POST /api/settings/anthropic sin sesión -> 401.
    const anthropic = await fetch(`${BASE_URL}/api/settings/anthropic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-ant-test" }),
    });
    check(
      "POST /api/settings/anthropic sin sesión -> 401",
      anthropic.status === 401,
      `status=${anthropic.status}`,
    );
  } finally {
    console.log("\nMatando next dev…");
    child.kill("SIGTERM");
    // Turbopack a veces deja hijos (el bundler) colgando del proceso padre; un
    // SIGKILL de respaldo tras un margen corto evita que el script se quede
    // esperando a que salgan solos.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!child.killed) child.kill("SIGKILL");
  }

  console.log(`\n${failures === 0 ? "OK" : "FAIL"} — ${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
