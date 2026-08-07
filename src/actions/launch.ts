import {
  action,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createWorkspace,
  HerdrApiError,
  makeAgentSessionName,
  startAgent,
} from "../herdr/client";
import { keyFace } from "../render/key-image";
import { raiseTerminal } from "../terminal";

/** Indigo — distinct from live status greens/ambers so launch keys read as "actions". */
const LAUNCH_COLOR = 0x5c6bc0;

/** How long to wait for a fresh pane's shell before giving up on agent.start. */
const SHELL_READY_TIMEOUT_MS = 12_000;
const SHELL_READY_POLL_MS = 250;

type LaunchSettings = {
  /** Button + workspace label. */
  name?: string;
  /** Directory for the new workspace shell (`~` expanded). */
  path?: string;
  /** Optional agent kind to start (claude, codex, grok, …). Empty = shell only. */
  agent?: string;
};

/**
 * Launch a Herdr workspace at a configured path, optionally starting an agent.
 *
 * Example: name=my-app, path=~/src/my-app, agent=claude
 * → new workspace labelled "my-app", shell in that dir, `claude` started.
 *
 * There is no single workspace.create+command API. We create the workspace
 * (shell already in cwd), then agent.start once the pane is at a prompt.
 * agent.start's `name` must be unique across managed agents — we mint one
 * from label + kind rather than reusing the bare kind string.
 */
@action({ UUID: "dev.herdr.deck.launch" })
export class LaunchWorkspace extends SingletonAction<LaunchSettings> {
  override onWillAppear(ev: WillAppearEvent<LaunchSettings>): void | Promise<void> {
    if (!ev.action.isKey()) return;
    void this.paint(ev.action, ev.payload.settings);
  }

  override onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<LaunchSettings>,
  ): void | Promise<void> {
    if (!ev.action.isKey()) return;
    void this.paint(ev.action, ev.payload.settings);
  }

  override onWillDisappear(_ev: WillDisappearEvent<LaunchSettings>): void | Promise<void> {
    // nothing to tear down — launch keys are stateless
  }

  override async onKeyDown(ev: KeyDownEvent<LaunchSettings>): Promise<void> {
    const settings = ev.payload.settings;
    const name = (settings.name ?? "").trim();
    const path = (settings.path ?? "").trim();
    const agentKind = (settings.agent ?? "").trim().toLowerCase();

    if (!path) {
      await ev.action.showAlert();
      streamDeck.logger.warn("Launch key pressed with no path configured");
      return;
    }

    const cwd = expandPath(path);
    const label = name || basenameHint(cwd);

    try {
      streamDeck.logger.info(
        `Launch workspace label=${label} cwd=${cwd} agent=${agentKind || "(none)"}`,
      );
      const created = await createWorkspace({
        cwd,
        label,
        focus: true,
      });

      if (agentKind) {
        const sessionName = makeAgentSessionName(agentKind, label);
        streamDeck.logger.info(
          `Starting agent kind=${agentKind} name=${sessionName} pane=${created.paneId}`,
        );
        await startAgentWhenReady(agentKind, sessionName, created.paneId);
      }

      await raiseTerminal();
      await ev.action.showOk();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      streamDeck.logger.error(`Launch failed: ${message}`);
      await ev.action.showAlert();
    }
  }

  private async paint(
    action: KeyAction<LaunchSettings>,
    settings: LaunchSettings,
  ): Promise<void> {
    await action.setTitle("");
    const name = (settings.name ?? "").trim();
    const path = (settings.path ?? "").trim();
    const agent = (settings.agent ?? "").trim().toLowerCase();

    const label = name || (path ? basenameHint(expandPath(path)) : "launch");
    await action.setImage(
      keyFace({
        color: LAUNCH_COLOR,
        label: truncate(label, 14),
        agent: agent || undefined,
      }),
    );
  }
}

/** Expand `~` / `~/…` to the home directory. Leaves other paths alone. */
export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path.startsWith("$HOME/") || path.startsWith("$HOME\\")) {
    return join(homedir(), path.slice(6));
  }
  return path;
}

function basenameHint(path: string): string {
  const cleaned = path.replace(/[/\\]+$/, "");
  const parts = cleaned.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll agent.start until the pane shell is ready, or fail after a deadline.
 *
 * Fresh workspace.create panes often aren't interactive yet — Herdr returns
 * target-busy until `available_shell_name` succeeds. That's a real race, not
 * a missing one-shot API (workspace.create has no command field).
 */
async function startAgentWhenReady(
  kind: string,
  sessionName: string,
  paneId: string,
): Promise<void> {
  const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await startAgent({
        kind,
        name: sessionName,
        paneId,
        timeoutMs: 30_000,
      });
      return;
    } catch (err) {
      lastError = err;
      if (isRetryableStartError(err)) {
        streamDeck.logger.debug(
          `agent.start not ready yet (${err instanceof Error ? err.message : err}); retrying`,
        );
        await sleep(SHELL_READY_POLL_MS);
        continue;
      }
      throw err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for shell on ${paneId}`);
}

function isRetryableStartError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  const code = err instanceof HerdrApiError ? (err.code ?? "").toLowerCase() : "";

  // Herdr codes / messages observed when the pane shell isn't interactive yet.
  if (code.includes("busy") || code.includes("unavailable") || code.includes("not_ready")) {
    return true;
  }
  if (
    message.includes("busy") ||
    message.includes("not ready") ||
    message.includes("unavailable") ||
    message.includes("shell") ||
    message.includes("interactive")
  ) {
    return true;
  }
  return false;
}
