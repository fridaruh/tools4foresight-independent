"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SyncButton } from "@/components/SyncButton";
import { LogoutButton } from "@/components/LogoutButton";
import { UserMenu } from "@/components/UserMenu";

// `section` empata con los bloques [data-section] de globals.css. El numero se
// muestra junto a la etiqueta: la nav es el indice del documento.
const ADMIN_SECTIONS = [
  { href: "/", label: "Catálogo", index: "01", section: "likes" },
  { href: "/enrich", label: "Análisis", index: "02", section: "enrich" },
  // El grafo entra como 03 y recorre lo que sigue (decision de Frida, 2026-08-19).
  { href: "/grafo", label: "Grafo", index: "03", section: "grafo" },
  { href: "/horizontes", label: "Horizontes", index: "04", section: "horizontes" },
  { href: "/categorias", label: "Taxonomía", index: "05", section: "categorias" },
  { href: "/conexion", label: "Sistema", index: "06", section: "conexion" },
  { href: "/usuarios", label: "Usuarios", index: "07", section: "usuarios" },
];

const MEMBER_SECTIONS = [
  { href: "/categorias", label: "Categorías", index: "01", section: "explora" },
  { href: "/senales", label: "Señales", index: "02", section: "senales" },
  // Grafo y Horizontes abiertos a miembros (decision de Frida, 2026-08-20): las
  // mismas paginas que el admin, sin avisos de jobs y con el horizonte en solo lectura.
  { href: "/grafo", label: "Grafo", index: "03", section: "grafo" },
  { href: "/horizontes", label: "Horizontes", index: "04", section: "horizontes-member" },
];

export function TopNav({
  role,
  user,
}: {
  role: "admin" | "member" | null;
  /** Usuario de la sesión de better-auth; null con la cookie legacy de Fase 0. */
  user: { name: string; email: string } | null;
}) {
  const pathname = usePathname();
  // Sin sesion (p.ej. en /login) no hay nada que navegar todavia: solo el logo.
  const sections = role === "admin" ? ADMIN_SECTIONS : role === "member" ? MEMBER_SECTIONS : [];

  return (
    <header className="sticky top-0 z-30 border-b border-ink bg-canvas/90 backdrop-blur">
      {/* En movil la nav baja a una segunda fila de ancho completo (order-last) y
          scrollea horizontal si las secciones no caben; de md hacia arriba vuelve a
          ser la fila unica de siempre. */}
      {/* En md la fila unica va justa (logo + 4 secciones + sync + salir): gaps y
          paddings compactos hasta lg, donde ya sobra el espacio. */}
      <div className="mx-auto flex w-full max-w-[100rem] flex-wrap items-center gap-x-4 px-4 sm:px-6 md:flex-nowrap md:gap-5 md:px-6 lg:gap-8 lg:px-10">
        {/* El lockup completo, no un recorte: la nav es el unico lugar de la app con
            espacio horizontal suficiente para que se lea entero. */}
        <Link href="/" aria-label="AI The New Sexy — inicio" className="shrink-0 py-3 md:py-4">
          <Image src="/logo-aitns.png" alt="AI The New Sexy" width={488} height={176} priority className="h-9 w-auto sm:h-12" />
        </Link>

        {/* En movil la nav baja a una segunda fila como reticula de 2 columnas: todas
            las secciones visibles a la vez, sin scroll escondido (una franja que
            scrollea deja "04 Sistema" invisible en un iPhone y nada indica que exista).
            En md+ vuelve a ser la fila unica de siempre. */}
        <nav className="flex items-center self-stretch max-md:order-last max-md:grid max-md:w-full max-md:grid-cols-2 max-md:border-t max-md:border-hairline">
          {sections.map((section, index) => {
            const active =
              section.href === "/" ? pathname === "/" : pathname.startsWith(section.href);
            return (
              <Link
                key={section.href}
                href={section.href}
                data-section={section.section}
                aria-current={active ? "page" : undefined}
                className={`nav-label flex items-center gap-1.5 self-stretch whitespace-nowrap border-l border-hairline px-3 py-3 transition-colors duration-150 last:border-r max-md:border-l-0 max-md:last:border-r-0 ${
                  index % 2 === 1 ? "max-md:border-l" : ""
                } ${index >= 2 ? "max-md:border-t" : ""} md:px-4 md:py-4 ${
                  active ? "nav-label-active" : "text-ink-subtle hover:text-ink"
                }`}
              >
                <span className={active ? "text-brand-orange" : "text-ink-tertiary"}>
                  {section.index}
                </span>
                {section.label}
              </Link>
            );
          })}
        </nav>

        {role !== null ? (
          <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-4">
            {role === "admin" && <SyncButton />}
            {user ? <UserMenu user={user} showSubscription={role === "member"} /> : <LogoutButton />}
          </div>
        ) : pathname === "/login" ? null : (
          // Puerta de entrada para miembros desde la landing: sin esto el unico
          // camino a /login era el CTA de venta "Quiero acceso al banco".
          <Link
            href="/login"
            className="nav-label ml-auto border border-ink px-4 py-2 text-ink transition-colors duration-150 hover:border-brand-orange hover:bg-brand-orange hover:text-brand-white"
          >
            Entrar
          </Link>
        )}
      </div>
    </header>
  );
}
