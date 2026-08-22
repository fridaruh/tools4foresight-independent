/**
 * Verificación real de las tareas del onboarding.
 *
 * La guía de configuración de Triangle marcaba las acciones por honor: un
 * checkbox que el usuario palomeaba. Aquí no. Las tareas que dejan rastro en la
 * base se preguntan a la base, así que la guía dice la verdad aunque el usuario
 * nunca toque un checkbox — y no se puede "completar" el onboarding sin haber
 * conectado X de verdad.
 *
 * Se lee una vez por request en `src/app/layout.tsx` (Server Component) y viaja
 * al provider como prop. Las acciones del usuario ya llaman a `router.refresh()`,
 * así que el layout se vuelve a ejecutar y las facts se actualizan solas: no
 * hace falta invalidar nada ni poner un endpoint.
 *
 * Toda lectura va dentro de `withOwner` (ver src/lib/tenant-db.ts): fuera de la
 * transacción con `app.owner_id` fijado, RLS devuelve cero filas en silencio y
 * la guía se vería vacía para todo el mundo.
 */
import { EMPTY_FACTS, type OnboardingFacts } from "@/lib/onboarding/config";
import { withOwner } from "@/lib/tenant-db";

/**
 * Estado real del tenant, reducido a lo que la guía necesita saber.
 *
 * Nunca lanza: el onboarding es decoración sobre la app, no puede tumbar el
 * layout de todas las páginas si la base está caída. En ese caso devuelve las
 * facts vacías y la guía simplemente muestra todo pendiente.
 */
export async function getOnboardingFacts(userId: string): Promise<OnboardingFacts> {
  try {
    return await withOwner(userId, async (tx) => {
      const [xToken, itemCount, publishedCount, clusters, snapshots] =
        await Promise.all([
          tx.xAuthToken.findFirst({ where: { userId }, select: { id: true } }),
          tx.likedItem.count({ where: { ownerId: userId } }),
          tx.likedItem.count({ where: { ownerId: userId, publishStatus: "published" } }),
          tx.semanticCluster.count({ where: { ownerId: userId } }),
          tx.graphSnapshot.count({ where: { ownerId: userId } }),
        ]);

      return {
        xConnected: Boolean(xToken),
        itemCount,
        publishedCount,
        // Un tema o un snapshot: cualquiera de los dos prueba que el grafo ya
        // corrió al menos una vez, aunque el resultado haya quedado en cero
        // temas por falta de señales publicadas.
        hasGraph: clusters > 0 || snapshots > 0,
        // Ver el comentario del campo en config.ts: hoy siempre false.
        categoriesReviewed: false,
      };
    });
  } catch {
    return EMPTY_FACTS;
  }
}
