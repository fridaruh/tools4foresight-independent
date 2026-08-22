/**
 * @deprecated El módulo se llama ahora `require-user`: ya no hay un rol "admin"
 * que decida qué señales se ven — cada usuario con sesión es dueño de su banco.
 * Este archivo solo re-exporta para no romper imports viejos; migrar a
 * `@/lib/require-user`.
 */
export * from "@/lib/require-user";
