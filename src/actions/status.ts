import {
  action,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { bridge } from "../herdr/bridge";
import { aggregateStatus, statusLabel } from "../herdr/status";
import type { BridgeState } from "../herdr/types";
import { keyFace } from "../render/key-image";
import { raiseTerminal } from "../terminal";

/**
 * Worst-state-wins light for the whole herd — the Stream Deck stand-in for
 * the Creator Micro's underglow. Pressing it focuses the first worst agent
 * so you can jump straight to whatever needs you.
 */
@action({ UUID: "dev.herdr.deck.status" })
export class HerdStatus extends SingletonAction {
  private unsubscribers = new Map<string, () => void>();

  override onWillAppear(ev: WillAppearEvent): void | Promise<void> {
    if (!ev.action.isKey()) return;
    const key = ev.action;
    const id = key.id;
    this.unsubscribers.get(id)?.();
    const unsub = bridge.subscribe((state) => {
      void this.paint(key, state);
    });
    this.unsubscribers.set(id, unsub);
  }

  override onWillDisappear(ev: WillDisappearEvent): void | Promise<void> {
    const id = ev.action.id;
    this.unsubscribers.get(id)?.();
    this.unsubscribers.delete(id);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const { agents, connected } = bridge.current;
    if (!connected || agents.length === 0) {
      await ev.action.showAlert();
      return;
    }

    const priority = ["blocked", "working", "unknown", "idle", "done"];
    let targetIndex = 0;
    outer: for (const status of priority) {
      for (let i = 0; i < agents.length; i++) {
        if (agents[i]!.status === status) {
          targetIndex = i;
          break outer;
        }
      }
    }

    try {
      await bridge.focusSlot(targetIndex);
      await raiseTerminal();
    } catch {
      await ev.action.showAlert();
    }
  }

  private async paint(action: KeyAction, state: BridgeState): Promise<void> {
    await action.setTitle("");

    if (!state.connected) {
      await action.setImage(keyFace({ status: "offline", label: "OFFLINE" }));
      return;
    }

    if (state.agents.length === 0) {
      await action.setImage(keyFace({ status: "empty", label: "none" }));
      return;
    }

    const agg = aggregateStatus(state.agents.map((a) => a.status));
    const status = agg ?? "empty";
    const count = state.agents.length;
    await action.setImage(
      keyFace({
        status,
        label: `${statusLabel(status)} · ${count}`,
      }),
    );
  }
}
