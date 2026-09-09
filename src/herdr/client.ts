import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseAgent, type HerdrAgent } from "./types";

/**
 * Client for the Herdr socket API: newline-delimited JSON over a Unix socket.
 *
 * The server handles **exactly one request per connection** and then closes,
 * with one exception: `events.subscribe` takes over the stream and pushes
 * events until the client disconnects. So a request opens a short-lived
 * connection, and each subscription owns a dedicated long-lived one.
 */

export function socketPath(): string {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "herdr", "herdr.sock");
}

let nextId = 0;
function requestId(): string {
  nextId += 1;
  return `hd_${nextId}`;
}

/** Herdr JSON-RPC error with optional machine-readable code. */
export class HerdrApiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "HerdrApiError";
    this.code = code;
  }
}

export async function request(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const path = socketPath();
  const payload = JSON.stringify({ id: requestId(), method, params }) + "\n";

  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    let settled = false;

    const finish = (err: Error | null, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result ?? {});
    };

    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(payload);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      if (!line) return;
      try {
        const object = JSON.parse(line) as {
          error?: { message?: string; code?: string };
          result?: Record<string, unknown>;
        };
        if (object.error) {
          finish(
            new HerdrApiError(
              object.error.message ?? "Herdr API error",
              object.error.code,
            ),
          );
        } else {
          finish(null, object.result ?? {});
        }
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.on("error", (err) => {
      finish(
        new Error(
          `Cannot reach Herdr at ${path}: ${err.message}`,
        ),
      );
    });

    socket.on("close", () => {
      if (!settled) finish(new Error(`Connection closed before ${method} responded`));
    });
  });
}

/**
 * Agents in the server's own order — workspace, then tab, then pane —
 * which is exactly how Herdr's agent panel lists them. Do not re-sort.
 */
export async function listAgents(): Promise<HerdrAgent[]> {
  const result = await request("agent.list");
  const raw = (result.agents as Record<string, unknown>[] | undefined) ?? [];
  return raw.map(parseAgent);
}

/** workspace_id → sidebar label (what Herdr's panel shows). */
export async function listWorkspaceLabels(): Promise<Record<string, string>> {
  const result = await request("workspace.list");
  const raw = (result.workspaces as Record<string, unknown>[] | undefined) ?? [];
  const labels: Record<string, string> = {};
  for (const ws of raw) {
    const id = typeof ws.workspace_id === "string" ? ws.workspace_id : undefined;
    const label = typeof ws.label === "string" ? ws.label : undefined;
    if (id && label) labels[id] = label;
  }
  return labels;
}

/** tab_id → tab bar label. `tab.list` without a workspace returns every tab. */
export async function listTabLabels(): Promise<Record<string, string>> {
  const result = await request("tab.list");
  const raw = (result.tabs as Record<string, unknown>[] | undefined) ?? [];
  const labels: Record<string, string> = {};
  for (const tab of raw) {
    const id = typeof tab.tab_id === "string" ? tab.tab_id : undefined;
    const label = typeof tab.label === "string" ? tab.label : undefined;
    if (id && label) labels[id] = label;
  }
  return labels;
}

export async function focusAgent(target: string): Promise<void> {
  await request("agent.focus", { target });
}

/** Move the attached TUI onto this tab (Herdr 0.9+ client-local views). */
export async function focusTab(tabId: string): Promise<void> {
  await request("tab.focus", { tab_id: tabId });
}

export type CreatedWorkspace = {
  workspaceId: string;
  label: string;
  paneId: string;
  tabId?: string;
};

/**
 * Create a Herdr workspace. `cwd` is where the root pane's shell starts
 * (so you get a free "cd"); `label` is the sidebar name; `focus` brings it
 * forward.
 */
export async function createWorkspace(opts: {
  cwd?: string;
  label?: string;
  focus?: boolean;
}): Promise<CreatedWorkspace> {
  const params: Record<string, unknown> = {
    focus: opts.focus ?? true,
  };
  if (opts.cwd) params.cwd = opts.cwd;
  if (opts.label) params.label = opts.label;

  const result = await request("workspace.create", params, 15_000);
  const workspace = (result.workspace as Record<string, unknown> | undefined) ?? {};
  const root = (result.root_pane as Record<string, unknown> | undefined) ?? {};
  const workspaceId = typeof workspace.workspace_id === "string" ? workspace.workspace_id : "";
  const paneId = typeof root.pane_id === "string" ? root.pane_id : "";
  if (!workspaceId || !paneId) {
    throw new Error("workspace.create returned no workspace/pane id");
  }
  return {
    workspaceId,
    label: typeof workspace.label === "string" ? workspace.label : opts.label ?? workspaceId,
    paneId,
    tabId: typeof root.tab_id === "string" ? root.tab_id : undefined,
  };
}

/**
 * Start a supported agent in an existing pane.
 *
 * Herdr treats `name` as a **unique session id** (not the agent kind). Reusing
 * `name: "claude"` when another managed agent already has that name fails with
 * a duplicate-name error — so callers should pass a unique `name` and the
 * executable kind separately (`kind: "claude"`, `name: "claude-ab12"`).
 *
 * The pane must be at an interactive shell prompt; otherwise Herdr returns a
 * "busy" / not-ready style error until the shell settles.
 */
export async function startAgent(opts: {
  /** Unique managed-agent name (a-z…, max 32). */
  name: string;
  /** Agent kind / executable: claude, codex, grok, … */
  kind: string;
  paneId: string;
  timeoutMs?: number;
}): Promise<void> {
  const kind = opts.kind.trim().toLowerCase();
  const name = opts.name.trim().toLowerCase();
  if (!kind) throw new Error("agent kind is empty");
  if (!name) throw new Error("agent name is empty");
  await request(
    "agent.start",
    {
      name,
      kind,
      pane_id: opts.paneId,
      timeout_ms: opts.timeoutMs ?? 30_000,
    },
    (opts.timeoutMs ?? 30_000) + 5_000,
  );
}

/**
 * Herdr agent names: start with a-z, then [a-z0-9_-], max 32 chars.
 * Used for the unique `name` field on agent.start.
 */
export function makeAgentSessionName(kind: string, label: string): string {
  const raw = `${kind}-${label}-${Math.random().toString(36).slice(2, 6)}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const fallback = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
  const candidate = (raw.length > 0 ? raw : fallback).slice(0, 32);
  // Must start with a letter.
  return /^[a-z]/.test(candidate) ? candidate : `a${candidate}`.slice(0, 32);
}

export type EventHandler = (event: Record<string, unknown>) => void;

/**
 * One subscription on its own connection. The first line is the ack;
 * everything after it is a pushed event.
 */
export class HerdrEventStream {
  private socket: Socket | null = null;
  private buffer = "";
  private ready = false;
  private stopped = false;

  constructor(
    private readonly subscriptions: Array<Record<string, unknown>>,
    private readonly onEvent: EventHandler,
    private readonly onClosed: (err?: Error) => void,
  ) {}

  start(): this {
    const path = socketPath();
    const socket = createConnection(path);
    this.socket = socket;

    socket.on("connect", () => {
      const envelope = {
        id: "hd_sub",
        method: "events.subscribe",
        params: { subscriptions: this.subscriptions },
      };
      socket.write(JSON.stringify(envelope) + "\n");
    });

    socket.on("data", (chunk) => {
      if (this.stopped) return;
      this.buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        let object: Record<string, unknown>;
        try {
          object = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!this.ready) {
          this.ready = true;
          continue;
        }
        this.onEvent(object);
      }
    });

    socket.on("error", (err) => {
      if (this.stopped) return;
      this.onClosed(err);
    });

    socket.on("close", () => {
      if (this.stopped) return;
      this.onClosed();
    });

    return this;
  }

  stop(): void {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
  }
}
