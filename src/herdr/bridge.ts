import streamDeck from "@elgato/streamdeck";

import { focusAgent, HerdrEventStream, listAgents, listWorkspaceLabels } from "./client";
import type { BridgeListener, BridgeState, HerdrAgent } from "./types";
import { focusTarget } from "./types";

/**
 * Single shared bridge: polls Herdr, listens for lifecycle/status events, and
 * fans state out to every Stream Deck action instance.
 *
 * Same liveness strategy as micro-manager:
 *   1. lifecycle stream (panes appear / disappear / gain agents)
 *   2. one status stream per agent pane (instant transitions)
 *   3. a slow poll of agent.list as a backstop
 *
 * agent.list is always the source of truth; events only decide *when* to look.
 */
class HerdrBridge {
  private listeners = new Set<BridgeListener>();
  private state: BridgeState = { agents: [], workspaceLabels: {}, connected: false };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycle: HerdrEventStream | null = null;
  private statusStreams = new Map<string, HerdrEventStream>();
  private started = false;

  readonly pollIntervalMs = 2500;
  readonly debounceMs = 100;

  get current(): BridgeState {
    return this.state;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    streamDeck.logger.info("Herd bridge starting");
    void this.refresh();
    this.startLifecycleStream();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.lifecycle?.stop();
    this.lifecycle = null;
    for (const stream of this.statusStreams.values()) stream.stop();
    this.statusStreams.clear();
  }

  subscribe(listener: BridgeListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    this.start();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Focus agent at the given 0-based slot in Herdr panel order. */
  async focusSlot(slot: number): Promise<void> {
    const agent = this.state.agents[slot];
    if (!agent) {
      throw new Error(`No agent in slot ${slot + 1}`);
    }
    const target = focusTarget(agent);
    if (!target) {
      throw new Error(`Agent in slot ${slot + 1} has no pane id`);
    }
    // Move the white border immediately; Herdr's pane.focused event (or the
    // next list) will reconcile if something races us.
    this.applyOptimisticFocus(slot);
    await focusAgent(target);
  }

  /** Flip focused flags locally so the ring doesn't wait on the next poll. */
  private applyOptimisticFocus(slot: number): void {
    if (!this.state.agents.length) return;
    const agents = this.state.agents.map((a, i) => ({
      ...a,
      focused: i === slot,
    }));
    this.publish({ ...this.state, agents });
  }

  agentAt(slot: number): HerdrAgent | undefined {
    return this.state.agents[slot];
  }

  private publish(next: BridgeState): void {
    this.state = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch (err) {
        streamDeck.logger.error("Bridge listener failed", err);
      }
    }
  }

  private schedule(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh();
    }, this.debounceMs);
  }

  private async refresh(): Promise<void> {
    if (!this.started) return;
    try {
      // Labels in parallel so a slow workspace.list can't block status for long.
      const [agents, workspaceLabels] = await Promise.all([
        listAgents(),
        listWorkspaceLabels().catch(() => this.state.workspaceLabels),
      ]);
      this.reconcileStatusStreams(agents);
      this.publish({ agents, workspaceLabels, connected: true, error: undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      streamDeck.logger.warn(`Herdr refresh failed: ${message}`);
      this.publish({
        agents: this.state.agents,
        workspaceLabels: this.state.workspaceLabels,
        connected: false,
        error: message,
      });
    }
  }

  private startLifecycleStream(): void {
    if (!this.started) return;
    this.lifecycle?.stop();
    this.lifecycle = new HerdrEventStream(
      [
        { type: "pane.created" },
        { type: "pane.closed" },
        { type: "pane.exited" },
        { type: "pane.agent_detected" },
        // Focus changes (Herdr keys, mouse, another client) — without this the
        // white border only moved on the 2.5s poll.
        { type: "pane.focused" },
        // Workspace rename so key labels track the sidebar.
        { type: "workspace.renamed" },
      ],
      () => this.schedule(),
      () => {
        this.lifecycle = null;
        if (!this.started) return;
        setTimeout(() => this.startLifecycleStream(), 2000);
      },
    ).start();
  }

  private reconcileStatusStreams(agents: HerdrAgent[]): void {
    const wanted = new Set(
      agents.map((a) => a.paneId).filter((id): id is string => !!id),
    );

    for (const [paneId, stream] of this.statusStreams) {
      if (!wanted.has(paneId)) {
        stream.stop();
        this.statusStreams.delete(paneId);
      }
    }

    for (const paneId of wanted) {
      if (this.statusStreams.has(paneId)) continue;
      const stream = new HerdrEventStream(
        [{ type: "pane.agent_status_changed", pane_id: paneId }],
        () => this.schedule(),
        () => {
          this.statusStreams.delete(paneId);
        },
      ).start();
      this.statusStreams.set(paneId, stream);
    }
  }
}

/** Process-wide singleton — every action shares one Herdr connection set. */
export const bridge = new HerdrBridge();
