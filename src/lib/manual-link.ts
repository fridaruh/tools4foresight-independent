import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Un enlace agregado a mano se guarda como un LikedItem mas, no como otra tabla.
 *
 * La razon es que todo lo que viene despues (fetch de contenido, categorizacion,
 * impacto y "por que importa") ya opera sobre `liked_items`, y un like a un articulo
 * normalmente ES un tweet que solo trae la URL — el mismo caso que ya sabian manejar
 * los prompts. Asi que se rellenan las columnas del tweet con lo que corresponde a un
 * enlace suelto y ningun job necesita una rama especial:
 *
 *   tweetId      -> id sintetico `manual:<uuid>` (la columna es unique y NOT NULL)
 *   tweetUrl     -> la URL, para que el boton "abrir" lleve al enlace y no a X
 *   tweetText    -> la URL, que es literalmente todo el texto que hay
 *   authorHandle -> el dominio (theverge.com), que es el "autor" util aqui
 *   likedAt      -> el momento en que se agrego; queda arriba en el orden, como debe
 */
export const MANUAL_SOURCE = "manual";

/** Marca de `likedAtSource` para items manuales: la fecha es exacta, no estimada. */
export const MANUAL_LIKED_AT_SOURCE = "manual";

export class InvalidLinkError extends Error {}

/**
 * Normaliza lo que se pego en el input. Acepta "ejemplo.com/nota" sin esquema porque
 * es como se copia un link de la barra del navegador en Safari.
 */
export function normalizeLinkUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new InvalidLinkError("Falta el enlace.");

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new InvalidLinkError("Ese texto no es una URL válida.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidLinkError("Solo se aceptan enlaces http o https.");
  }
  if (!url.hostname.includes(".")) {
    throw new InvalidLinkError("Ese texto no es una URL válida.");
  }

  return url.toString();
}

function hostHandle(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

export function manualItemInput(url: string): Prisma.LikedItemCreateInput {
  return {
    source: MANUAL_SOURCE,
    tweetId: `manual:${randomUUID()}`,
    authorHandle: hostHandle(url),
    authorName: null,
    tweetText: url,
    tweetUrl: url,
    // A diferencia de un like de X, aqui la fecha no se estima: es cuando Frida lo
    // agrego. Se marca con su propia fuente para que el tooltip no prometa una
    // estimacion que no aplica.
    likedAt: new Date(),
    likedAtSource: MANUAL_LIKED_AT_SOURCE,
    detectedAt: new Date(),
    contentUrl: url,
    fetchStatus: "pending",
  };
}
