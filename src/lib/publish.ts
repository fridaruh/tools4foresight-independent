// "not_relevant" existió un rato como estado propio y se unificó con
// enrichDiscarded (decisión de Frida, 2026-08-09): un solo botón ("Descartar")
// y una sola lista de excluidos en vez de dos.
export const PUBLISH_STATUSES = ["pending", "published"] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export function isPublishStatus(value: unknown): value is PublishStatus {
  return typeof value === "string" && (PUBLISH_STATUSES as readonly string[]).includes(value);
}

export type PublishabilityInput = {
  category: string | null;
  impact: string | null;
  whyMatters: string | null;
};

/** Lo mínimo para que una señal sea presentable a un miembro de pago. */
export function isPublishable(item: PublishabilityInput): boolean {
  return item.category !== null && item.impact !== null && item.whyMatters !== null;
}
