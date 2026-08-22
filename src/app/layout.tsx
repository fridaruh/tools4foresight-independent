import type { Metadata } from "next";
import Script from "next/script";
import { IBM_Plex_Mono, Inter, Inter_Tight } from "next/font/google";
import "./globals.css";
import { TopNav } from "@/components/TopNav";
import { getEffectiveRole, getSessionUser } from "@/lib/require-user";

// Las tres voces del sistema (DESIGN.md §5). Una sola familia por funcion en toda la
// app: la variedad tipografica por pantalla que habia antes contradice el "sistematico
// y modular" de la marca.

// Cuerpo, tablas, prosa larga.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

/**
 * Display: titulos y cifras grandes.
 *
 * La marca pide Suisse Intl, que es de licencia comercial y no esta en Google Fonts.
 * Inter Tight es la sustituta mas cercana disponible: misma familia neo-grotesca,
 * anchos mas cerrados que Inter, aguanta el peso Bold en tamaños grandes. Si Frida
 * compra la licencia de Suisse, se cambia aqui y en `--font-display`.
 */
const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

// Sistema: labels, metadata, navegacion, numeros, estados. Es la que le da a la
// interfaz el tono de documentacion tecnica.
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "tools4foresight — Señales, no ruido",
  description:
    "Banco curado de señales sobre IA, tecnología y cultura, con análisis de impacto — no solo el link.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [role, sessionUser] = await Promise.all([getEffectiveRole(), getSessionUser()]);

  return (
    <html
      lang="es"
      className={`${inter.variable} ${interTight.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-canvas text-ink">
        <Script
          src="https://datafa.st/js/script.js"
          data-website-id="dfid_rzE4VOYg4sdJXuBPrTH6Q"
          data-domain="tools4foresight.com"
          strategy="afterInteractive"
        />
        <TopNav
          role={role}
          user={sessionUser ? { name: sessionUser.name, email: sessionUser.email } : null}
        />
        {children}
      </body>
    </html>
  );
}
