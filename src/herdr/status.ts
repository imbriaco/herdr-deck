/**
 * Status colours and aggregate priority — kept in step with Scott's
 * micro-manager StatusMapper so the two pads speak the same language.
 *
 * Herdr reports "done" for an agent that has finished and that you have not
 * looked at yet, and "idle" once it is focused. Blue = waiting to be read,
 * green = quiet.
 */

export type AgentStatus = "blocked" | "working" | "done" | "idle" | "unknown";

/** Highest priority first: the first state present across all agents wins. */
export const STATUS_PRIORITY: AgentStatus[] = [
  "blocked",
  "working",
  "unknown",
  "idle",
  "done",
];

/** Packed 0xRRGGBB — same palette as micro-manager. */
export const STATUS_COLORS: Record<AgentStatus | "empty" | "offline", number> = {
  blocked: 0xff2d2d,
  working: 0xffa000,
  done: 0x00b0ff,
  idle: 0x00c853,
  unknown: 0x00c853,
  empty: 0x2a2a2a,
  offline: 0x1a1a1a,
};

export function normalizeStatus(status: string): AgentStatus {
  switch (status) {
    case "blocked":
    case "working":
    case "done":
    case "idle":
      return status;
    default:
      return "unknown";
  }
}

/** Worst-state-wins across the herd, or undefined when nothing is running. */
export function aggregateStatus(statuses: string[]): AgentStatus | undefined {
  if (statuses.length === 0) return undefined;
  const present = new Set(statuses.map(normalizeStatus));
  for (const state of STATUS_PRIORITY) {
    if (present.has(state)) return state;
  }
  return "unknown";
}

export function statusLabel(status: AgentStatus | "empty" | "offline"): string {
  switch (status) {
    case "blocked":
      return "BLOCKED";
    case "working":
      return "WORKING";
    case "done":
      return "DONE";
    case "idle":
      return "IDLE";
    case "unknown":
      return "…";
    case "empty":
      return "";
    case "offline":
      return "OFFLINE";
  }
}
