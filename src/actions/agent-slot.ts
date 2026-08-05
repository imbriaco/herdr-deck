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

import { bridge } from "../herdr/bridge";
import { normalizeStatus } from "../herdr/status";
import { displayName, type BridgeState } from "../herdr/types";
import { keyFace } from "../render/key-image";
import { raiseTerminal } from "../terminal";

type SlotSettings = {
  /**
   * 0-based index into Herdr's agent.list order.
   * When missing, slot is inferred from the key's coordinates
   * (reading order: left→right, top→bottom).
   */
  slot?: number | string;
};

/**
 * One key = one agent slot. Colour tracks status; label is the Herdr workspace
 * name (sidebar), painted into the key image near the top.
 * Press focuses that agent and raises the terminal.
 *
 * On a classic 15-key deck the top two rows are the herdr surface (10 keys).
 * Empty settings auto-map from position, so a fresh drag-and-drop just works.
 */
@action({ UUID: "dev.herdr.deck.agent-slot" })
export class AgentSlot extends SingletonAction<SlotSettings> {
  private unsubscribers = new Map<string, () => void>();
  private settings = new Map<string, SlotSettings>();

  override onWillAppear(ev: WillAppearEvent<SlotSettings>): void | Promise<void> {
    if (!ev.action.isKey()) return;
    const key = ev.action;
    const id = key.id;

    void this.ensureSlot(key, ev.payload.settings).then((settings) => {
      this.settings.set(id, settings);
      this.unsubscribers.get(id)?.();
      const unsub = bridge.subscribe((state) => {
        void this.paint(key, this.settings.get(id) ?? settings, state);
      });
      this.unsubscribers.set(id, unsub);
    });
  }

  override onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<SlotSettings>,
  ): void | Promise<void> {
    if (!ev.action.isKey()) return;
    this.settings.set(ev.action.id, ev.payload.settings);
    void this.paint(ev.action, ev.payload.settings, bridge.current);
  }

  override onWillDisappear(ev: WillDisappearEvent<SlotSettings>): void | Promise<void> {
    const id = ev.action.id;
    this.unsubscribers.get(id)?.();
    this.unsubscribers.delete(id);
    this.settings.delete(id);
  }

  override async onKeyDown(ev: KeyDownEvent<SlotSettings>): Promise<void> {
    const slot = resolveSlot(ev.payload.settings, ev.action);
    try {
      await bridge.focusSlot(slot);
      await raiseTerminal();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ev.action.showAlert();
      // Brief overlay only — normal paint clears the Stream Deck title again.
      await ev.action.setTitle(truncate(message, 12));
    }
  }

  /**
   * If the user never set a slot (broken PI / fresh drop), persist one from
   * the key's coordinates so every key gets a unique index and the PI shows it.
   */
  private async ensureSlot(
    action: KeyAction<SlotSettings>,
    settings: SlotSettings,
  ): Promise<SlotSettings> {
    if (hasExplicitSlot(settings)) return settings;

    const slot = slotFromCoordinates(action);
    const next: SlotSettings = { ...settings, slot };
    streamDeck.logger.info(
      `Agent key at ${coordLabel(action)} → auto slot ${slot + 1}`,
    );
    try {
      await action.setSettings(next);
    } catch (err) {
      streamDeck.logger.warn("Failed to persist auto slot", err);
    }
    return next;
  }

  private async paint(
    action: KeyAction<SlotSettings>,
    settings: SlotSettings,
    state: BridgeState,
  ): Promise<void> {
    const slot = resolveSlot(settings, action);

    // Label is baked into the SVG so placement is reliable; clear any leftover
    // Stream Deck title (which was stuck on the bottom for existing keys).
    await action.setTitle("");

    if (!state.connected) {
      await action.setImage(
        keyFace({
          status: "offline",
          label: slot === 0 ? "offline" : `${slot + 1}`,
        }),
      );
      return;
    }

    const agent = state.agents[slot];
    if (!agent) {
      await action.setImage(keyFace({ status: "empty", label: `${slot + 1}` }));
      return;
    }

    const status = normalizeStatus(agent.status);
    const name = truncate(displayName(agent, state.workspaceLabels), 14);
    await action.setImage(
      keyFace({
        status,
        focused: agent.focused,
        label: name,
      }),
    );
  }
}

function hasExplicitSlot(settings: SlotSettings): boolean {
  const raw = settings.slot;
  if (raw === undefined || raw === null || raw === "") return false;
  if (typeof raw === "string" && raw.trim() === "") return false;
  return true;
}

/** Resolve 0-based slot: explicit setting wins, else key position. */
function resolveSlot(settings: SlotSettings, action: KeyAction<SlotSettings>): number {
  if (hasExplicitSlot(settings)) {
    const n = Number(settings.slot);
    if (Number.isFinite(n)) return clampSlot(n);
  }
  return slotFromCoordinates(action);
}

function slotFromCoordinates(action: KeyAction<SlotSettings>): number {
  const coords = action.coordinates;
  if (!coords) return 0;
  const columns = action.device.size?.columns ?? 5;
  return clampSlot(coords.column + coords.row * columns);
}

function clampSlot(n: number): number {
  return Math.max(0, Math.min(14, Math.floor(n)));
}

function coordLabel(action: KeyAction<SlotSettings>): string {
  const c = action.coordinates;
  return c ? `${c.column},${c.row}` : "?";
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
