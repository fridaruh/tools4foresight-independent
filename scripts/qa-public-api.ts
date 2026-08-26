/**
 * QA de la API pública multi-tenant (PLAN_MCP, Fase 4 — criterio de aceptación).
 *
 *   npm run qa:public
 *
 * Es LA prueba que le da o le quita valor a todo lo construido en PLAN_MCP: si la
 * clave de A puede ver una fila de B, el resto del plan da igual. Todo lo demás
 * (DTOs, cursores, rate limit) es plomería alrededor de esta única garantía.
 *
 * POR QUÉ POR HTTP CONTRA UN `next dev` REAL, Y NO LLAMANDO A LOS HANDLERS:
 *   el camino real de un cliente MCP es Bearer -> `src/proxy.ts` -> route handler
 *   -> `withPublicApi` -> `withOwner`. Un test que importara los handlers y los
 *   invocara a mano se saltaría justo la capa (el proxy) que hace que nada de esto
 *   sea alcanzable: el proxy corta `/api/*` sin cookie de sesión, y la API pública
 *   sobrevive SOLO porque `api/public` está excluido de su matcher. Ese matcher es
 *   una línea que alguien puede "limpiar" en cualquier momento sin enterarse de que
 *   deja al MCP entero devolviendo 401; el check 5 existe para que se entere aquí.
 *
 * Puerto propio (3126) para no chocar con el 3123 de `qa:ui`: los dos scripts
 * corren en la misma pasada de `npm run qa`, y aunque hoy sea secuencial, un
 * puerto compartido es un fallo intermitente esperando a que deje de serlo.
 *
 * Limpieza garantizada en el `finally`: se borran los dos usuarios (cascade se
 * lleva su banco entero) y se mata el `next dev` aunque un check reviente a la
 * mitad. La base de desarrollo tiene datos reales de la usuaria y no puede quedar
 * sucia.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { prisma } from "../src/lib/prisma";
import { withOwner, withPlatformBypass } from "../src/lib/tenant-db";
import { seedTenant } from "../src/lib/seed-tenant";
import { createApiKey, revokeApiKey } from "../src/lib/api-keys";

const PORT = 3126;
const BASE_URL = `http://localhost:${PORT}`;
const API = `${BASE_URL}/api/public/v1`;
const READY_TIMEOUT_MS = 90_000;

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ============================== next dev ============================================

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

// ============================== Cliente HTTP ========================================

type ApiResponse = {
  status: number;
  /** El cuerpo crudo. Es sobre ESTE string que se buscan fugas: un id ajeno
   *  escondido en un campo que nadie tipó igual aparece aquí. */
  text: string;
  /** El cuerpo ya parseado, sin tipar. `unknown` a propósito: un verificador tiene
   *  que poder mirar CUALQUIER forma de respuesta —incluida una equivocada— sin que
   *  el compilador le prometa una que quizá no llegó. Se navega con `at()`. */
  json: unknown;
};

/**
 * Navega el JSON por una ruta de claves y devuelve `undefined` en cuanto el camino
 * se rompe. Es el sustituto tipado del `?.` encadenado sobre un `any`.
 */
function at(value: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `key === null` = sin cabecera Authorization (el caso del 401 del check 4). */
async function api(path: string, key: string | null): Promise<ApiResponse> {
  const headers: Record<string, string> = {};
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${API}${path}`, { headers });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Un cuerpo no-JSON es en sí mismo el hallazgo (p.ej. el HTML de /login si el
    // proxy volviera a interceptar la ruta): se conserva en `text` y el check lo
    // reporta.
  }
  return { status: res.status, text, json };
}

// ============================== Montaje de tenants ==================================

/**
 * Cada tenant se siembra con cantidades DISTINTAS y CONOCIDAS en cada tabla. No es
 * cosmético: los endpoints agregados (`/meta`, `/pestel`, `/categories`,
 * `/horizons`, `/graph`) devuelven números, y ahí una fuga no se ve como un id
 * ajeno sino como un conteo inflado. Con A y B sembrados con los mismos números,
 * `signals: 8` seguiría diciendo 8 aunque estuviera sumando los cuatro de B.
 */
type TenantSpec = {
  label: "A" | "B";
  /** Total de señales; las primeras `published` van publicadas y el resto pending. */
  signals: number;
  published: number;
  /** Índices (dentro de `signals`) que comparten EXACTAMENTE el mismo `likedAt`.
   *  Es el caso que rompe un cursor de un solo campo — ver el check 7. */
  tiedLikedAt: number[];
  /** `[dimensión PESTEL, índices de señal]`. Cantidades distintas por tenant. */
  pestel: Array<[string, number[]]>;
  /** Temas vivos: `[horizonte, vitalidad, índices de señal que le apuntan]`. */
  aliveThemes: Array<{ horizon: string; vitality: number; members: number[] }>;
  /** Tema fósil: no tiene señales apuntándole (el grafo les quita el clusterId al
   *  morir), solo `lastMemberIds`. */
  deadTheme: { horizon: string; vitality: number; lastMembers: number[] };
  /** Pares de índices de señales publicadas que forman aristas. */
  links: Array<[number, number]>;
  /** Cuántas corridas del grafo. La primera lleva los miembros del snapshot. */
  snapshots: number;
  /** Índices de señal que quedan en `graph_snapshot_members` del primer snapshot. */
  snapshotMembers: number[];
  /** Categorías extra sobre el catálogo base de `seedTenant` (10). */
  extraCategories: string[];
  /** Categoría que el modelo "propuso" y no está en el catálogo (sale con
   *  `inCatalog: false` en `/categories`). */
  proposedCategory: string | null;
};

const SPEC_A: TenantSpec = {
  label: "A",
  signals: 8,
  published: 5,
  tiedLikedAt: [2, 3, 4],
  pestel: [
    ["social", [0, 1, 2, 3]],
    ["legal", [4, 5]],
  ],
  aliveThemes: [
    { horizon: "H1", vitality: 5.5, members: [0, 1, 2] },
    { horizon: "H2", vitality: 3.25, members: [3] },
  ],
  deadTheme: { horizon: "H1", vitality: 0.5, lastMembers: [5, 6] },
  links: [
    [0, 1],
    [0, 2],
    [1, 2],
    [3, 4],
  ],
  snapshots: 2,
  snapshotMembers: [0, 1, 2, 3],
  extraCategories: ["QA extra A"],
  proposedCategory: "Categoría propuesta A",
};

const SPEC_B: TenantSpec = {
  label: "B",
  signals: 4,
  published: 2,
  tiedLikedAt: [],
  pestel: [
    ["economic", [0, 1, 2]],
    ["social", [3]],
  ],
  aliveThemes: [{ horizon: "H1", vitality: 9.75, members: [0, 1] }],
  deadTheme: { horizon: "H3", vitality: 0.25, lastMembers: [2] },
  links: [[0, 1]],
  snapshots: 1,
  snapshotMembers: [0, 1],
  extraCategories: [],
  proposedCategory: null,
};

type Tenant = {
  spec: TenantSpec;
  userId: string;
  /** La clave que usa todo el script. */
  apiKey: string;
  /** Una segunda clave, solo para revocarla y comprobar el 401 (check 4). Se
   *  separa de la principal para no dejar al resto del script sin credencial. */
  revocable: { id: string; plaintext: string };
  signalIds: string[];
  publishedIds: string[];
  pendingIds: string[];
  aliveThemeIds: string[];
  deadThemeId: string;
  macroIds: string[];
  snapshotIds: string[];
  /** Marca de texto única del tenant, sembrada en el `tweetText` de cada señal y en
   *  el nombre de cada tema/macro-tema. Aparecer en la respuesta del OTRO tenant es
   *  una fuga, la busque o no un campo tipado. */
  marker: string;
  /** Todo lo que jamás debe aparecer en una respuesta del otro tenant. */
  forbidden: string[];
};

const CATALOG_SIZE = 10; // src/config/categories.ts

async function makeUser(label: string): Promise<string> {
  const id = randomUUID();
  await withPlatformBypass((tx) =>
    tx.user.create({
      data: {
        id,
        name: `QA public ${label}`,
        email: `qa-public-${label}-${id}@tools4foresight.test`,
        role: "user",
      },
    }),
  );
  return id;
}

/** Base fija (no `new Date()`) para que las fechas sembradas sean reproducibles. */
const BASE_DATE = new Date("2026-03-01T12:00:00.000Z");

function likedAtFor(spec: TenantSpec, index: number): Date {
  // Los índices empatados comparten la fecha del primero del grupo: así el orden
  // `likedAt desc` tiene un tramo donde solo el `id` desempata.
  const effective = spec.tiedLikedAt.includes(index) ? (spec.tiedLikedAt[0] as number) : index;
  return new Date(BASE_DATE.getTime() - effective * 24 * 60 * 60 * 1000);
}

async function seedTenantData(spec: TenantSpec, userId: string): Promise<Tenant> {
  const marker = `QA-PUBLIC-${spec.label}`;
  const catalog = await withOwner(userId, (tx) =>
    tx.category.findMany({ orderBy: { position: "asc" }, select: { name: true } }),
  );
  const catalogName = catalog[spec.label === "A" ? 0 : 1]?.name ?? "Otros";

  return withOwner(userId, async (tx) => {
    // Categorías extra: hacen que `/categories` y `meta.counts.categories` den un
    // número distinto para A y para B (el catálogo base es idéntico en los dos).
    for (const [i, name] of spec.extraCategories.entries()) {
      await tx.category.create({
        data: { ownerId: userId, name, description: `${marker} extra`, position: CATALOG_SIZE + i },
      });
    }

    // Macro-temas primero: `semantic_clusters.macro_cluster_id` los referencia.
    const macroIds: string[] = [];
    for (const [i, theme] of spec.aliveThemes.entries()) {
      const macro = await tx.macroCluster.create({
        data: {
          ownerId: userId,
          name: `${marker} macro ${i}`,
          summary: `${marker} resumen de macro ${i}`,
          horizon: theme.horizon,
        },
        select: { id: true },
      });
      macroIds.push(macro.id);
    }

    const aliveThemeIds: string[] = [];
    for (const [i, theme] of spec.aliveThemes.entries()) {
      const cluster = await tx.semanticCluster.create({
        data: {
          ownerId: userId,
          name: `${marker} tema vivo ${i}`,
          summary: `${marker} resumen del tema vivo ${i}`,
          membersHash: `${marker}-alive-${i}`,
          size: theme.members.length,
          status: "alive",
          horizon: theme.horizon,
          horizonSuggested: theme.horizon,
          vitality: theme.vitality,
          velocity30d: theme.members.length,
          macroClusterId: macroIds[i],
        },
        select: { id: true },
      });
      aliveThemeIds.push(cluster.id);
    }

    const dead = await tx.semanticCluster.create({
      data: {
        ownerId: userId,
        name: `${marker} tema fósil`,
        summary: `${marker} resumen del tema fósil`,
        membersHash: `${marker}-dead`,
        size: spec.deadTheme.lastMembers.length,
        status: "dead",
        horizon: spec.deadTheme.horizon,
        vitality: spec.deadTheme.vitality,
        diedAt: BASE_DATE,
      },
      select: { id: true },
    });

    // Señales. El `clusterId` solo lo llevan las que pertenecen a un tema VIVO: es
    // lo que hace el job de grafo, y es lo que hace que `/themes/{fósil}/signals`
    // tenga que caer a `lastMemberIds` para no devolver vacío.
    const memberOf = new Map<number, string>();
    spec.aliveThemes.forEach((theme, i) => {
      for (const index of theme.members) memberOf.set(index, aliveThemeIds[i] as string);
    });
    const pestelOf = new Map<number, string[]>();
    for (const [dimension, indexes] of spec.pestel) {
      for (const index of indexes) pestelOf.set(index, [...(pestelOf.get(index) ?? []), dimension]);
    }

    const signalIds: string[] = [];
    for (let i = 0; i < spec.signals; i += 1) {
      const published = i < spec.published;
      const category =
        i === spec.published - 1 && spec.proposedCategory ? spec.proposedCategory : published ? catalogName : null;
      const row = await tx.likedItem.create({
        data: {
          ownerId: userId,
          tweetId: `${marker}:${i}:${randomUUID()}`,
          authorHandle: `qa_public_${spec.label.toLowerCase()}`,
          authorName: `${marker} autor`,
          tweetText: `${marker} señal ${i} — texto de prueba`,
          tweetUrl: `https://example.test/${spec.label}/${i}`,
          likedAt: likedAtFor(spec, i),
          category,
          pestel: pestelOf.get(i) ?? [],
          tags: [`${marker.toLowerCase()}-tag`],
          tldr: `${marker} tldr ${i}`,
          whyMatters: `${marker} por qué importa ${i}`,
          publishStatus: published ? "published" : "pending",
          publishedAt: published ? BASE_DATE : null,
          // Solo las publicadas se embeben (jobs/embed.ts): es lo que hace que
          // `/graph` cuente exactamente `published` nodos.
          embeddedAt: published ? BASE_DATE : null,
          clusterId: memberOf.get(i) ?? null,
          vitality: 1 - i / 100,
        },
        select: { id: true },
      });
      signalIds.push(row.id);
    }

    // `lastMemberIds` se escribe después: necesita ids de señales que ya existan.
    for (const [i, theme] of spec.aliveThemes.entries()) {
      await tx.semanticCluster.update({
        where: { id: aliveThemeIds[i] },
        data: {
          lastMemberIds: theme.members.map((index) => signalIds[index] as string),
          lastSignalAt: BASE_DATE,
        },
      });
    }
    await tx.semanticCluster.update({
      where: { id: dead.id },
      data: { lastMemberIds: spec.deadTheme.lastMembers.map((index) => signalIds[index] as string) },
    });

    // Aristas. El par va ordenado (itemAId < itemBId), como el job de grafo.
    for (const [a, b] of spec.links) {
      const [itemAId, itemBId] = [signalIds[a] as string, signalIds[b] as string].sort();
      await tx.semanticLink.create({
        data: { ownerId: userId, itemAId, itemBId, score: 0.7 + a / 100 },
      });
    }

    const snapshotIds: string[] = [];
    for (let i = 0; i < spec.snapshots; i += 1) {
      const snapshot = await tx.graphSnapshot.create({
        data: {
          ownerId: userId,
          takenAt: new Date(BASE_DATE.getTime() + i * 60 * 60 * 1000),
          trigger: "manual",
          nodes: spec.published,
          links: spec.links.length,
          clustersAlive: spec.aliveThemes.length,
          clustersDead: 1,
          orphans: 0,
        },
        select: { id: true },
      });
      snapshotIds.push(snapshot.id);

      // El primer tema vivo aparece en TODAS las corridas: eso le da a
      // `/themes/{id}/history` una serie de `spec.snapshots` puntos.
      const themesInSnapshot = i === 0 ? aliveThemeIds : aliveThemeIds.slice(0, 1);
      for (const [j, clusterId] of themesInSnapshot.entries()) {
        await tx.graphSnapshotCluster.create({
          data: {
            ownerId: userId,
            snapshotId: snapshot.id,
            clusterId,
            name: `${marker} tema vivo ${j}`,
            size: spec.aliveThemes[j]?.members.length ?? 0,
            status: "alive",
            vitality: spec.aliveThemes[j]?.vitality ?? 0,
            velocity30d: 1,
          },
        });
      }

      if (i === 0) {
        await tx.graphSnapshotMember.createMany({
          data: spec.snapshotMembers.map((index) => ({
            ownerId: userId,
            snapshotId: snapshot.id,
            itemId: signalIds[index] as string,
            clusterId: memberOf.get(index) ?? null,
            vitality: 0.9,
          })),
        });
      }
    }

    return {
      spec,
      userId,
      apiKey: "",
      revocable: { id: "", plaintext: "" },
      signalIds,
      publishedIds: signalIds.slice(0, spec.published),
      pendingIds: signalIds.slice(spec.published),
      aliveThemeIds,
      deadThemeId: dead.id,
      macroIds,
      snapshotIds,
      marker,
      forbidden: [userId, marker, ...signalIds, ...aliveThemeIds, dead.id, ...macroIds, ...snapshotIds],
    };
  });
}

// ============================== Utilidades de inspección ============================

/** Recorre el JSON completo y devuelve todas las CLAVES de objeto que aparecen. */
function allKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, acc);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      acc.add(key);
      allKeys(child, acc);
    }
  }
  return acc;
}

/** Los ids de una lista de DTOs, tolerando que `data` sea objeto o arreglo. */
function idsOf(response: ApiResponse, field = "id"): string[] {
  return asArray(at(response.json, "data"))
    .map((row) => at(row, field))
    .filter((v): v is string => typeof v === "string");
}

function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((v) => sb.has(v));
}

/** Las siete rutas de detalle: reciben un id (o clave) en el path. */
function detailPaths(t: Tenant): Array<{ name: string; path: string }> {
  return [
    { name: "/signals/{id}", path: `/signals/${t.signalIds[0]}` },
    { name: "/signals/{id}/neighbors", path: `/signals/${t.signalIds[0]}/neighbors` },
    { name: "/themes/{id}", path: `/themes/${t.aliveThemeIds[0]}` },
    { name: "/themes/{id}/signals", path: `/themes/${t.aliveThemeIds[0]}/signals` },
    { name: "/themes/{id}/history", path: `/themes/${t.aliveThemeIds[0]}/history` },
    { name: "/snapshots/{id}", path: `/snapshots/${t.snapshotIds[0]}?includeMembers=true` },
  ];
}

/** Las 17 rutas, resueltas con los ids del tenant que hace la llamada. */
function allSeventeenPaths(t: Tenant): Array<{ name: string; path: string }> {
  return [
    { name: "/signals", path: "/signals?limit=100" },
    ...detailPaths(t),
    { name: "/themes", path: "/themes?limit=100" },
    { name: "/macro-themes", path: "/macro-themes" },
    { name: "/horizons", path: "/horizons" },
    { name: "/horizons/{key}", path: "/horizons/H1" },
    { name: "/categories", path: "/categories" },
    { name: "/pestel", path: "/pestel" },
    { name: "/meta", path: "/meta" },
    { name: "/graph", path: "/graph" },
    { name: "/snapshots", path: "/snapshots?limit=100" },
    { name: "/health", path: "/health" },
  ];
}

// ================================== Los checks ======================================

/**
 * Check 1 — aislamiento endpoint por endpoint, y check 3 — `ownerId` nunca sale.
 *
 * Se hacen sobre el MISMO barrido de las 17 respuestas porque las dos preguntas se
 * responden con el mismo cuerpo: "¿aparece algo de B?" y "¿aparece el identificador
 * del tenant?". La búsqueda es sobre el texto crudo, no sobre campos tipados: una
 * fuga por un campo que nadie previó (un `summary` con el nombre del tema de otro,
 * un id anidado tres niveles adentro) no se ve mirando solo `data[].id`.
 */
async function checkIsolationAndOwnerId(self: Tenant, other: Tenant): Promise<void> {
  const L = self.spec.label;
  for (const { name, path } of allSeventeenPaths(self)) {
    const res = await api(path, self.apiKey);
    if (res.status !== 200) {
      check(`[${L}] ${name} responde 200 con su propia clave`, false, `status=${res.status} body=${res.text.slice(0, 200)}`);
      continue;
    }

    const leaked = other.forbidden.filter((needle) => res.text.includes(needle));
    check(
      `[${L}] ${name} no contiene NADA del tenant ${other.spec.label}`,
      leaked.length === 0,
      `fugas: ${leaked.slice(0, 3).join(", ")}`,
    );

    const keys = allKeys(res.json);
    check(
      `[${L}] ${name} no expone la clave ownerId/owner_id`,
      !keys.has("ownerId") && !keys.has("owner_id"),
      "public-dto.ts §lista negra: ownerId es el campo prohibido nº1",
    );
    check(
      `[${L}] ${name} no contiene el id de NINGÚN tenant en el cuerpo`,
      !res.text.includes(self.userId) && !res.text.includes(other.userId),
      "el valor del ownerId apareció en la respuesta aunque la clave no",
    );
  }
}

/**
 * Check 1 (segunda mitad) — los ids de las listas son EXACTAMENTE los del tenant.
 *
 * "Ningún id de B" no basta: una lista vacía también cumple eso. Comparar contra el
 * conjunto sembrado detecta a la vez la fuga (id de más) y la regresión (id de
 * menos), que es lo que un check de conteo se salta.
 */
async function checkListIdentity(t: Tenant): Promise<void> {
  const L = t.spec.label;

  const signals = await api("/signals?limit=100", t.apiKey);
  check(
    `[${L}] /signals devuelve exactamente los ids de ${L}`,
    sameSet(idsOf(signals), t.signalIds),
    `devolvió ${idsOf(signals).length}, esperaba ${t.signalIds.length}`,
  );

  const themes = await api("/themes?limit=100", t.apiKey);
  check(
    `[${L}] /themes devuelve exactamente los temas de ${L} (vivos + fósil)`,
    sameSet(idsOf(themes), [...t.aliveThemeIds, t.deadThemeId]),
    `devolvió ${idsOf(themes).length}, esperaba ${t.aliveThemeIds.length + 1}`,
  );

  const macros = await api("/macro-themes", t.apiKey);
  check(
    `[${L}] /macro-themes devuelve exactamente los macro-temas de ${L}`,
    sameSet(idsOf(macros), t.macroIds),
    `devolvió ${idsOf(macros).length}, esperaba ${t.macroIds.length}`,
  );

  const snapshots = await api("/snapshots?limit=100", t.apiKey);
  check(
    `[${L}] /snapshots devuelve exactamente los snapshots de ${L}`,
    sameSet(idsOf(snapshots), t.snapshotIds),
    `devolvió ${idsOf(snapshots).length}, esperaba ${t.snapshotIds.length}`,
  );

  // Fósil: sus señales salen de `lastMemberIds`, no de la relación `clusterId`.
  const fossil = await api(`/themes/${t.deadThemeId}/signals?limit=100`, t.apiKey);
  const expectedFossil = t.spec.deadTheme.lastMembers.map((i) => t.signalIds[i] as string);
  check(
    `[${L}] /themes/{fósil}/signals cae a lastMemberIds y devuelve sus señales`,
    sameSet(idsOf(fossil), expectedFossil),
    `devolvió ${idsOf(fossil).length}, esperaba ${expectedFossil.length}`,
  );
}

/**
 * Check 1 (tercera mitad) — pedir con la clave de A un id que pertenece a B.
 *
 * Tiene que ser 404 y nunca 403: un 403 confirmaría que el id existe en el banco de
 * otra persona, que es exactamente la correlación entre bancos que la lista negra de
 * `ownerId` existe para impedir. Se hace en las DOS direcciones: un fallo asimétrico
 * (p.ej. un handler que filtra por `ownerId` a mano en un sentido y confía solo en
 * RLS en el otro) es un fallo real y se escapa probando una sola.
 */
async function checkCrossTenantDetail(self: Tenant, other: Tenant): Promise<void> {
  const L = self.spec.label;
  const O = other.spec.label;
  for (const { name, path } of detailPaths(other)) {
    const res = await api(path, self.apiKey);
    check(
      `[${L}->${O}] ${name} con un id de ${O} responde 404`,
      res.status === 404,
      res.status === 200
        ? "¡FUGA! devolvió 200 con contenido de otro banco"
        : res.status === 403
          ? "403 confirma que el id existe en otro banco: tiene que ser 404"
          : `status=${res.status}`,
    );
  }

  // `/horizons/{key}` no lleva un id de tenant en el path (el conjunto H1/H2/H3 es
  // cerrado y compartido), así que aquí el equivalente al 404 cruzado es que los
  // NÚMEROS del horizonte sean los propios — se verifica en el check 2 — y que una
  // clave fuera del conjunto sea 400, no 404: no es un recurso que falte.
  const bad = await api("/horizons/H9", self.apiKey);
  check(
    `[${L}] /horizons/{key} con una clave desconocida responde 400 (conjunto cerrado)`,
    bad.status === 400,
    `status=${bad.status}`,
  );
}

/**
 * Check 2 — los agregados no filtran.
 *
 * `/meta`, `/pestel`, `/categories`, `/horizons` y `/graph` devuelven números. Aquí
 * una fuga no se ve como un id ajeno (el check 1 no la vería) sino como un conteo
 * inflado. Por eso A y B están sembrados con cantidades distintas y conocidas, y se
 * exige el número EXACTO, no ">= 0".
 */
async function checkAggregates(t: Tenant): Promise<void> {
  const s = t.spec;
  const L = s.label;

  const expectedMeta = {
    signals: s.signals,
    publishedSignals: s.published,
    themesAlive: s.aliveThemes.length,
    themesDead: 1,
    macroThemes: s.aliveThemes.length,
    links: s.links.length,
    categories: CATALOG_SIZE + s.extraCategories.length,
    snapshots: s.snapshots,
  };
  const meta = await api("/meta", t.apiKey);
  const counts = at(meta.json, "data", "counts");
  for (const [key, expected] of Object.entries(expectedMeta)) {
    check(
      `[${L}] /meta counts.${key} == ${expected} (solo lo suyo)`,
      at(counts, key) === expected,
      `devolvió ${at(counts, key)}`,
    );
  }

  // PESTEL: A tiene 4 señales sociales y B tiene 1. Si /pestel de A dijera 5, la
  // suma estaría cruzando bancos aunque ningún id se haya asomado.
  const expectedPestel = new Map<string, number>(s.pestel.map(([dim, ids]) => [dim, ids.length]));
  const pestel = await api("/pestel", t.apiKey);
  const pestelRows = asArray(at(pestel.json, "data"));
  check(`[${L}] /pestel devuelve las 6 dimensiones`, pestelRows.length === 6, `devolvió ${pestelRows.length}`);
  for (const row of pestelRows) {
    const dimension = String(at(row, "key"));
    const expected = expectedPestel.get(dimension) ?? 0;
    check(
      `[${L}] /pestel ${dimension} cuenta ${expected}`,
      at(row, "signalCount") === expected,
      `devolvió ${at(row, "signalCount")}`,
    );
  }

  // Categorías: el catálogo de cada quien más las que el modelo propuso.
  const categories = await api("/categories", t.apiKey);
  const catRows = asArray(at(categories.json, "data"));
  const enCatalogo = catRows.filter((r) => at(r, "inCatalog") === true).length;
  const fueraDeCatalogo = catRows.length - enCatalogo;
  check(
    `[${L}] /categories devuelve ${CATALOG_SIZE + s.extraCategories.length} del catálogo`,
    enCatalogo === CATALOG_SIZE + s.extraCategories.length,
    `devolvió ${enCatalogo}`,
  );
  check(
    `[${L}] /categories marca ${s.proposedCategory ? 1 : 0} categoría(s) fuera de catálogo`,
    fueraDeCatalogo === (s.proposedCategory ? 1 : 0),
    `devolvió ${fueraDeCatalogo}`,
  );
  const catTotal = catRows.reduce<number>((sum, r) => sum + Number(at(r, "signalCount") ?? 0), 0);
  // Las señales sin categoría (las pending que no la recibieron) no suman.
  const expectedCatTotal = s.published;
  check(
    `[${L}] /categories suma ${expectedCatTotal} señales categorizadas`,
    catTotal === expectedCatTotal,
    `sumó ${catTotal}`,
  );

  // Horizontes: temas VIVOS y señales que les apuntan, por horizonte.
  const horizons = await api("/horizons", t.apiKey);
  const horizonRows = asArray(at(horizons.json, "data"));
  check(`[${L}] /horizons devuelve los tres horizontes`, horizonRows.length === 3, `devolvió ${horizonRows.length}`);
  for (const key of ["H1", "H2", "H3"]) {
    const themes = s.aliveThemes.filter((th) => th.horizon === key);
    const expectedThemes = themes.length;
    const expectedSignals = themes.reduce((sum, th) => sum + th.members.length, 0);
    const expectedVitality = themes.reduce((sum, th) => sum + th.vitality, 0);
    const row = horizonRows.find((r) => at(r, "key") === key);
    check(
      `[${L}] /horizons ${key}: ${expectedThemes} temas / ${expectedSignals} señales`,
      at(row, "themeCount") === expectedThemes && at(row, "signalCount") === expectedSignals,
      `devolvió ${at(row, "themeCount")} temas / ${at(row, "signalCount")} señales`,
    );
    check(
      `[${L}] /horizons ${key}: vitalitySum ${expectedVitality}`,
      Math.abs(Number(at(row, "vitalitySum") ?? -1) - expectedVitality) < 1e-6,
      `devolvió ${at(row, "vitalitySum")}`,
    );
  }

  // El detalle de un horizonte tiene que contar IGUAL que el panorama (si divergen,
  // un agente que los cruce ve números que no cuadran y desconfía de los dos).
  const h1 = await api("/horizons/H1", t.apiKey);
  const h1Row = horizonRows.find((r) => at(r, "key") === "H1");
  check(
    `[${L}] /horizons/H1 cuenta lo mismo que /horizons`,
    at(h1.json, "data", "themeCount") === at(h1Row, "themeCount") &&
      at(h1.json, "data", "signalCount") === at(h1Row, "signalCount"),
    `detalle ${at(h1.json, "data", "themeCount")}/${at(h1.json, "data", "signalCount")} vs panorama ${at(h1Row, "themeCount")}/${at(h1Row, "signalCount")}`,
  );

  // Grafo: nodos = señales embebidas (solo las publicadas), aristas = sus enlaces.
  const graph = await api("/graph", t.apiKey);
  const stats = at(graph.json, "data", "stats");
  check(`[${L}] /graph stats.nodes == ${s.published}`, at(stats, "nodes") === s.published, `devolvió ${at(stats, "nodes")}`);
  check(
    `[${L}] /graph stats.edges == ${s.links.length}`,
    at(stats, "edges") === s.links.length,
    `devolvió ${at(stats, "edges")}`,
  );
  check(
    `[${L}] /graph stats.themesAlive == ${s.aliveThemes.length}`,
    at(stats, "themesAlive") === s.aliveThemes.length,
    `devolvió ${at(stats, "themesAlive")}`,
  );
  check(`[${L}] /graph stats.themesDead == 1`, at(stats, "themesDead") === 1, `devolvió ${at(stats, "themesDead")}`);
  const nodeIds = asArray(at(graph.json, "data", "nodes"))
    .map((n) => at(n, "id"))
    .filter((v): v is string => typeof v === "string");
  check(
    `[${L}] /graph solo tiene nodos de ${L}`,
    sameSet(nodeIds, t.publishedIds),
    `devolvió ${nodeIds.length} nodos`,
  );
}

/**
 * Check 4 — ciclo de vida de la clave.
 *
 * Los tres 401 (sin cabecera, clave inventada, clave revocada) y el 200 del camino
 * feliz. El último no es decorativo: un script que solo comprobara los 401 pasaría
 * en verde con la API entera caída.
 */
async function checkKeyLifecycle(t: Tenant): Promise<void> {
  // El bucket por IP de claves inválidas (10/min, public-api-auth.ts) vive en
  // `rate_limits`, que NO es de tenant: sobrevive entre corridas del QA. Sin este
  // reset, correr el script dos veces en un minuto devolvería 429 en vez de 401 y
  // el fallo parecería del handler.
  await prisma.$executeRaw`DELETE FROM rate_limits WHERE key = 'public-api:unknown'`;

  const sinCabecera = await api("/meta", null);
  check("sin cabecera Authorization -> 401", sinCabecera.status === 401, `status=${sinCabecera.status}`);
  check(
    "sin cabecera Authorization -> code 'unauthorized'",
    at(sinCabecera.json, "error", "code") === "unauthorized",
    `code=${at(sinCabecera.json, "error", "code")}`,
  );

  const inventada = await api("/meta", "t4f_clave_que_no_existe_en_ninguna_parte");
  check("clave inventada -> 401", inventada.status === 401, `status=${inventada.status}`);
  check(
    "clave inventada -> code 'invalid_api_key'",
    at(inventada.json, "error", "code") === "invalid_api_key",
    `code=${at(inventada.json, "error", "code")}`,
  );

  // La clave revocable se estrena aquí: primero se comprueba que servía, y recién
  // después se revoca. Si no, un 401 tras revocar no probaría nada (podría haber
  // estado rota desde el principio).
  const antes = await api("/health", t.revocable.plaintext);
  check("la clave revocable funcionaba ANTES de revocarla -> 200", antes.status === 200, `status=${antes.status}`);

  const revocada = await revokeApiKey(t.userId, t.revocable.id);
  check("revokeApiKey devuelve true para una clave propia y vigente", revocada === true);

  const despues = await api("/health", t.revocable.plaintext);
  check("clave revocada -> 401", despues.status === 401, `status=${despues.status}`);
  check(
    "clave revocada -> code 'invalid_api_key'",
    at(despues.json, "error", "code") === "invalid_api_key",
    `code=${at(despues.json, "error", "code")}`,
  );

  const feliz = await api("/meta", t.apiKey);
  check("clave válida -> 200 (el camino feliz también es parte de la prueba)", feliz.status === 200, `status=${feliz.status}`);
}

/**
 * Check 5 — el proxy deja pasar `/api/public`.
 *
 * `src/proxy.ts` corta CUALQUIER `/api/*` sin cookie de sesión con un 401 plano.
 * La API pública sobrevive solo porque `api/public` está excluido de su `matcher`.
 * Un agente MCP nunca manda cookie: si alguien vuelve a meter `api/public` en el
 * matcher, la API entera queda inalcanzable y el síntoma ("401 con una clave
 * válida") no apunta a ese archivo. Este check es el que lo apunta.
 */
async function checkProxyPassthrough(t: Tenant): Promise<void> {
  const res = await api("/health", t.apiKey);
  const cortadoPorElProxy = at(res.json, "ok") === false && at(res.json, "error") === "No autorizado";
  check(
    "/health con clave válida y SIN cookie de sesión -> 200 (api/public excluido del matcher de src/proxy.ts)",
    res.status === 200 && !cortadoPorElProxy,
    cortadoPorElProxy
      ? "lo cortó el proxy: alguien volvió a meter `api/public` en el matcher de src/proxy.ts"
      : `status=${res.status}`,
  );
  check("/health reporta db: ok", at(res.json, "data", "db") === "ok", `db=${at(res.json, "data", "db")}`);
}

/**
 * Check 6 — se ve el banco completo.
 *
 * PLAN_MCP §0.2: se eliminó `PUBLISHED_ONLY`, la persona ES la curadora de su banco
 * y lo ve entero. Sin filtro salen publicadas Y pendientes; `publishStatus` pasó de
 * ser un scope secreto a un filtro que el usuario pide.
 */
async function checkPublishStatusVisibility(t: Tenant): Promise<void> {
  const L = t.spec.label;

  const todas = await api("/signals?limit=100", t.apiKey);
  check(
    `[${L}] /signals sin filtro devuelve publicadas Y pendientes (${t.spec.signals})`,
    sameSet(idsOf(todas), t.signalIds),
    `devolvió ${idsOf(todas).length}`,
  );
  const estados = new Set(asArray(at(todas.json, "data")).map((row) => at(row, "publishStatus")));
  check(
    `[${L}] /signals expone publishStatus con los dos valores`,
    estados.has("published") && estados.has("pending"),
    `estados vistos: ${[...estados].join(", ")}`,
  );

  const publicadas = await api("/signals?limit=100&publishStatus=published", t.apiKey);
  check(
    `[${L}] /signals?publishStatus=published devuelve solo las ${t.spec.published} publicadas`,
    sameSet(idsOf(publicadas), t.publishedIds),
    `devolvió ${idsOf(publicadas).length}`,
  );

  const pendientes = await api("/signals?limit=100&publishStatus=pending", t.apiKey);
  check(
    `[${L}] /signals?publishStatus=pending devuelve solo las ${t.pendingIds.length} pendientes`,
    sameSet(idsOf(pendientes), t.pendingIds),
    `devolvió ${idsOf(pendientes).length}`,
  );
}

/**
 * Check 7 — paginación sin repetidos ni saltos.
 *
 * El bug clásico del cursor es sobre un campo con EMPATES: `likedAt` es una
 * estimación y varias señales comparten fecha, así que un cursor de un solo campo se
 * salta las filas empatadas que quedaron del otro lado del corte. El cursor compuesto
 * `(likedAt, id)` de public-cursor.ts existe justamente para eso, y el tenant A está
 * sembrado con tres señales de `likedAt` idéntico para que el límite de página caiga
 * DENTRO del empate y el caso se ejerza de verdad — no que pase por no tocarlo.
 */
async function checkPagination(t: Tenant): Promise<void> {
  const L = t.spec.label;
  const limit = 3;
  const recogidos: string[] = [];
  let cursor: string | null = null;
  let paginas = 0;
  let repetido: string | null = null;

  for (;;) {
    const query: string = `/signals?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page: ApiResponse = await api(query, t.apiKey);
    if (page.status !== 200) {
      check(`[${L}] paginación: la página ${paginas + 1} responde 200`, false, `status=${page.status}`);
      return;
    }
    paginas += 1;

    for (const id of idsOf(page)) {
      if (recogidos.includes(id)) repetido = id;
      recogidos.push(id);
    }

    if (at(page.json, "meta", "hasMore") !== true) {
      check(
        `[${L}] paginación: nextCursor es null si y solo si hasMore es false`,
        at(page.json, "meta", "nextCursor") === null,
        `nextCursor=${at(page.json, "meta", "nextCursor")}`,
      );
      break;
    }
    const nextCursor = at(page.json, "meta", "nextCursor");
    cursor = typeof nextCursor === "string" ? nextCursor : null;
    if (!cursor) {
      check(`[${L}] paginación: hasMore=true trae nextCursor`, false, "hasMore true sin cursor");
      return;
    }
    if (paginas > 20) {
      check(`[${L}] paginación: termina`, false, "más de 20 páginas para 8 señales: el cursor no avanza");
      return;
    }
  }

  check(`[${L}] paginación: ninguna señal se repite entre páginas`, repetido === null, `repetida: ${repetido}`);
  check(
    `[${L}] paginación: no hay saltos — recorrió las ${t.signalIds.length} señales de ${L}`,
    sameSet(recogidos, t.signalIds) && recogidos.length === t.signalIds.length,
    `recogió ${recogidos.length} (${new Set(recogidos).size} únicos) de ${t.signalIds.length}`,
  );
  check(
    `[${L}] paginación: el recorrido no trajo ninguna señal ajena`,
    recogidos.every((id) => t.signalIds.includes(id)),
  );
}

// ==================================== main ==========================================

async function main() {
  const userA = await makeUser("a");
  const userB = await makeUser("b");
  let child: DevChild | null = null;

  try {
    await seedTenant(userA);
    await seedTenant(userB);
    const tenantA = await seedTenantData(SPEC_A, userA);
    const tenantB = await seedTenantData(SPEC_B, userB);

    for (const t of [tenantA, tenantB]) {
      t.apiKey = (await createApiKey(t.userId, `QA public ${t.spec.label}`)).plaintext;
      const revocable = await createApiKey(t.userId, `QA revocable ${t.spec.label}`);
      t.revocable = { id: revocable.id, plaintext: revocable.plaintext };
    }

    console.log(`\nArrancando "next dev -p ${PORT}"…`);
    child = spawn("npx", ["next", "dev", "-p", String(PORT)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    await waitForReady(child);
    console.log("next dev listo. Corriendo checks…\n");

    console.log("── Check 5: el proxy deja pasar /api/public ─────────────────────");
    await checkProxyPassthrough(tenantA);

    console.log("\n── Check 1: aislamiento endpoint por endpoint + check 3: ownerId ─");
    await checkIsolationAndOwnerId(tenantA, tenantB);
    await checkIsolationAndOwnerId(tenantB, tenantA);

    console.log("\n── Check 1: las listas devuelven exactamente lo propio ───────────");
    await checkListIdentity(tenantA);
    await checkListIdentity(tenantB);

    console.log("\n── Check 1: detalle cruzado A->B y B->A (404, nunca 403) ────────");
    await checkCrossTenantDetail(tenantA, tenantB);
    await checkCrossTenantDetail(tenantB, tenantA);

    console.log("\n── Check 2: los agregados no filtran ────────────────────────────");
    await checkAggregates(tenantA);
    await checkAggregates(tenantB);

    console.log("\n── Check 6: se ve el banco completo (publicadas y pendientes) ───");
    await checkPublishStatusVisibility(tenantA);
    await checkPublishStatusVisibility(tenantB);

    console.log("\n── Check 7: paginación con empates de likedAt ───────────────────");
    await checkPagination(tenantA);

    console.log("\n── Check 4: ciclo de vida de la clave ───────────────────────────");
    await checkKeyLifecycle(tenantA);
  } finally {
    if (child) {
      console.log("\nMatando next dev…");
      child.kill("SIGTERM");
      // Turbopack deja hijos colgando del proceso padre; un SIGKILL de respaldo
      // tras un margen corto evita que el script se quede esperando.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (!child.killed) child.kill("SIGKILL");
    }

    // Pase lo que pase: los dos usuarios se van (cascade se lleva su banco entero,
    // sus claves y sus snapshots) y los buckets de rate limit que dejaron. La base
    // de desarrollo tiene datos reales de la usuaria y no puede quedar sucia.
    await withPlatformBypass(async (tx) => {
      await tx.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    });
    await prisma.$executeRaw`
      DELETE FROM rate_limits
      WHERE key IN (${`public:${userA}`}, ${`public:${userB}`},
                    ${`public:expensive:${userA}`}, ${`public:expensive:${userB}`})
    `;
    console.log("[cleanup] usuarios de prueba y buckets de rate limit borrados");
    await prisma.$disconnect();
  }

  console.log(`\n${failures === 0 ? "OK" : "FAIL"} — ${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
