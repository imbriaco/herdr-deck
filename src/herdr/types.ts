/** One agent as reported by Herdr's `agent.list`. */
export type HerdrAgent = {
  terminalId?: string;
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
  agent: string;
  status: string;
  cwd?: string;
  foregroundCwd?: string;
  focused: boolean;
};

export type BridgeState = {
  /** Live agents in Herdr panel order. */
  agents: HerdrAgent[];
  /** workspace_id → Herdr sidebar label. */
  workspaceLabels: Record<string, string>;
  /** True when we last successfully talked to the socket. */
  connected: boolean;
  /** Human-readable last error, if any. */
  error?: string;
  /**
   * Brightness multiplier for blocked-key breathing (0.35..1).
   * Full brightness when nothing is blocked.
   */
  breath: number;
};

export type BridgeListener = (state: BridgeState) => void;

/** Target for `agent.focus` — pane ids only (Herdr 0.7.5+). */
export function focusTarget(agent: HerdrAgent): string | undefined {
  return agent.paneId ?? agent.terminalId;
}

/**
 * Where the agent is actually working. `foregroundCwd` follows a `cd` inside
 * the pane; `cwd` is only where the pane started.
 */
export function workingDirectory(agent: HerdrAgent): string | undefined {
  for (const candidate of [agent.foregroundCwd, agent.cwd]) {
    if (candidate && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** Last path component of the working directory. */
export function shortName(agent: HerdrAgent): string {
  const dir = workingDirectory(agent);
  if (!dir) return agent.agent;
  const parts = dir.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || agent.agent;
}

/**
 * Label shown on the Stream Deck key — match Herdr's sidebar.
 * Prefer the workspace label (e.g. "sv2-trim"); fall back to cwd basename.
 */
export function displayName(
  agent: HerdrAgent,
  workspaceLabels: Record<string, string> = {},
): string {
  if (agent.workspaceId) {
    const label = workspaceLabels[agent.workspaceId];
    if (label && label.trim()) return label.trim();
  }
  return shortName(agent);
}

export function parseAgent(raw: Record<string, unknown>): HerdrAgent {
  return {
    terminalId: str(raw.terminal_id),
    paneId: str(raw.pane_id),
    tabId: str(raw.tab_id),
    workspaceId: str(raw.workspace_id),
    agent: str(raw.agent) ?? "agent",
    status: str(raw.agent_status) ?? "unknown",
    cwd: str(raw.cwd),
    foregroundCwd: str(raw.foreground_cwd),
    focused: raw.focused === true,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
