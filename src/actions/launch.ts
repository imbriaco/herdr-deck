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

import { createWorkspace, startAgent } from "../herdr/client";
import { keyFace } from "../render/key-image";
import { raiseTerminal } from "../terminal";

/** Indigo — distinct from live status greens/ambers so launch keys read as "actions". */
const LAUNCH_COLOR = 0x5c6bc0;

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
    const agent = (settings.agent ?? "").trim().toLowerCase();

    if (!path) {
      await ev.action.showAlert();
      streamDeck.logger.warn("Launch key pressed with no path configured");
      return;
    }

    const cwd = expandPath(path);
    const label = name || basenameHint(cwd);

    try {
      streamDeck.logger.info(
        `Launch workspace label=${label} cwd=${cwd} agent=${agent || "(none)"}`,
      );
      const created = await createWorkspace({
        cwd,
        label,
        focus: true,
      });

      if (agent) {
        await startAgentWithRetry(agent, created.paneId);
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
 * Fresh workspace panes are usually at a prompt immediately; if agent.start
 * races the shell, wait once and try again.
 */
async function startAgentWithRetry(agent: string, paneId: string): Promise<void> {
  try {
    await startAgent({ agent, paneId });
  } catch (err) {
    streamDeck.logger.warn(
      `agent.start failed, retrying in 1.5s: ${err instanceof Error ? err.message : err}`,
    );
    await sleep(1500);
    await startAgent({ agent, paneId });
  }
}
