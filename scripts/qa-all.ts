#!/usr/bin/env tsx
/**
 * QA unificado: ejecuta secuencialmente todos los scripts qa:* del package.json.
 *
 * Falla si alguno devuelve código != 0 e imprime un resumen PASS/FAIL.
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const packageJsonPath = path.join(process.cwd(), "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
const scripts = packageJson.scripts || {};

// Extraer todos los scripts que empiezan por "qa:" y no son "qa:ui"
// Ejecutar qa:ui al final
const qaScriptsNames = Object.keys(scripts)
  .filter((name) => name.startsWith("qa:"))
  .sort((a, b) => {
    // Poner qa:ui al final
    if (a === "qa:ui") return 1;
    if (b === "qa:ui") return -1;
    return a.localeCompare(b);
  });

console.log("🔍 QA unificado — ejecutando secuencialmente...\n");
console.log(`Scripts encontrados: ${qaScriptsNames.join(", ")}\n`);

const results: { script: string; passed: boolean }[] = [];
let failed = false;

for (const scriptName of qaScriptsNames) {
  const scriptCommand = scripts[scriptName];
  console.log(`▶️  ${scriptName}`);

  try {
    execSync(scriptCommand, {
      stdio: "inherit",
      shell: "/bin/bash",
    });
    results.push({ script: scriptName, passed: true });
    console.log(`✓ ${scriptName} PASS\n`);
  } catch (error) {
    results.push({ script: scriptName, passed: false });
    console.error(`✗ ${scriptName} FAIL\n`);
    failed = true;
  }
}

// Resumen
console.log("───────────────────────────────────────");
console.log("📊 Resumen QA:");
console.log("───────────────────────────────────────\n");

for (const result of results) {
  const status = result.passed ? "✓ PASS" : "✗ FAIL";
  console.log(`  ${status} — ${result.script}`);
}

console.log();

const passCount = results.filter((r) => r.passed).length;
const failCount = results.filter((r) => !r.passed).length;

if (failCount === 0) {
  console.log(`✨ Todos los tests pasaron (${passCount}/${results.length})\n`);
  process.exit(0);
} else {
  console.log(`❌ ${failCount} test(s) fallaron (${passCount}/${results.length} pasaron)\n`);
  process.exit(1);
}
