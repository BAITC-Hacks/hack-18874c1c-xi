import type { Kzt, Role } from "@money-graph/contracts";

/** Labels and shapes are presentation only; role assignment comes from the API. */
export const ROLES_PRESENTATION = {
  consolidator: { label: "Консолидатор", shape: "diamond", symbol: "◆", token: "--xi-volt" },
  transit: { label: "Транзитный", shape: "rectangle", symbol: "■", token: "--xi-paper" },
  distributor: { label: "Распределитель", shape: "triangle", symbol: "▲", token: "--xi-ultra" },
  terminal: { label: "Терминальный", shape: "pentagon", symbol: "⬟", token: "--xi-slate-300" },
  coordinator: { label: "Координатор", shape: "hexagon", symbol: "⬢", token: "--xi-volt" },
  peripheral: { label: "Периферийный", shape: "ellipse", symbol: "●", token: "--xi-slate" },
} as const satisfies Record<Role, { label: string; shape: string; symbol: string; token: string }>;

/** Preserve every supplied digit, including fractional trailing zeros, without Number. */
export function formatKzt(value: Kzt): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return `${value} ₸`;
  const [, sign, integer, fraction] = match;
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  return `${sign}${grouped}${fraction === undefined ? "" : `,${fraction}`} ₸`;
}
