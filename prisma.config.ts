// Config de la CLI de Prisma (migraciones, generate, studio).
//
// Las migraciones van por DIRECT_URL (conexión directa, sin el pooler de Neon):
// pgbouncer en transaction mode no soporta los locks de sesión ni los DDL
// multi-statement que necesita `migrate`. El runtime (src/lib/prisma.ts) sigue
// usando DATABASE_URL, que sí es el pooler.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"],
  },
});
