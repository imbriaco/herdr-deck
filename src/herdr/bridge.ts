import streamDeck from "@elgato/streamdeck";

import {
  focusAgent,
  focusTab,
  HerdrEventStream,
  listAgents,
  listTabLabels,
  listWorkspaceLabels,
} from "./client";
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
 *
 * Blocked keys “breathe” in software: a short interval updates `breath` so
 * action paint can dim the red fill like the Creator Micro’s LED effect.
 */
class HerdrBridge {
  private listeners = new Set<BridgeListener>();
  private state: BridgeState = {
    agents: [],
    workspaceLabels: {},
    tabLabels: {},
    connected: false,
    breath: 1,
  };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private breathTimer: ReturnType<typeof setInterval> | null = null;
  private breathOrigin = 0;
  private lastBreathStep = -1;
  private lifecycle: HerdrEventStream | null = null;
  private statusStreams = new Map<string, HerdrEventStream>();
  private started = false;

  readonly pollIntervalMs = 2500;
  readonly debounceMs = 100;
  /** Full breath cycle length — similar feel to firmware “breathing”. */
  readonly breathPeriodMs = 2200;
  /** How often we push a new frame while something is blocked. */
  readonly breathTickMs = 90;
  /** Dim floor so blocked never goes fully dark. */
  readonly breathMin = 0.32;
  readonly breathMax = 1;

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
    this.stopBreath();
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
    // agent.focus updates server-side agent focus; Herdr 0.9+ TUI clients
    // keep their own workspace/tab view and need tab.focus to actually move.
    if (agent.tabId) await focusTab(agent.tabId);
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
    this.syncBreathTimer(next);
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
      const [agents, workspaceLabels, tabLabels] = await Promise.all([
        listAgents(),
        listWorkspaceLabels().catch(() => this.state.workspaceLabels),
        listTabLabels().catch(() => this.state.tabLabels),
      ]);
      this.reconcileStatusStreams(agents);
      this.publish({
        agents,
        workspaceLabels,
        tabLabels,
        connected: true,
        error: undefined,
        breath: this.state.breath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      streamDeck.logger.warn(`Herdr refresh failed: ${message}`);
      this.publish({
        agents: this.state.agents,
        workspaceLabels: this.state.workspaceLabels,
        tabLabels: this.state.tabLabels,
        connected: false,
        error: message,
        breath: this.state.breath,
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
        // Workspace / tab rename so key labels track the sidebar.
        { type: "workspace.renamed" },
        { type: "tab.renamed" },
        { type: "tab.created" },
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

  // --- Breathing ----------------------------------------------------------

  private anyBlocked(state: BridgeState): boolean {
    return state.connected && state.agents.some((a) => a.status === "blocked");
  }

  private syncBreathTimer(state: BridgeState): void {
    if (this.anyBlocked(state)) {
      this.startBreath();
      return;
    }
    const wasBreathing = this.breathTimer !== null || state.breath !== 1;
    this.stopBreath();
    if (wasBreathing && this.state.breath !== 1) {
      // Snap back to full brightness and repaint once (don't go through publish).
      this.state = { ...this.state, breath: 1 };
      for (const listener of this.listeners) {
        try {
          listener(this.state);
        } catch (err) {
          streamDeck.logger.error("Bridge listener failed", err);
        }
      }
    }
  }

  private startBreath(): void {
    if (this.breathTimer) return;
    this.breathOrigin = Date.now();
    this.lastBreathStep = -1;
    this.breathTimer = setInterval(() => this.breathTick(), this.breathTickMs);
    this.breathTick();
  }

  private stopBreath(): void {
    if (!this.breathTimer) return;
    clearInterval(this.breathTimer);
    this.breathTimer = null;
    this.lastBreathStep = -1;
  }

  private breathTick(): void {
    if (!this.started || !this.anyBlocked(this.state)) {
      this.stopBreath();
      if (this.state.breath !== 1) {
        this.publish({ ...this.state, breath: 1 });
      }
      return;
    }

    const t =
      ((Date.now() - this.breathOrigin) / this.breathPeriodMs) * Math.PI * 2;
    // 0..1 sine, then map into [breathMin, breathMax].
    const wave = 0.5 + 0.5 * Math.sin(t);
    const breath =
      this.breathMin + (this.breathMax - this.breathMin) * wave;

    // Quantize so we don't spam setImage with imperceptible changes.
    const step = Math.round(breath * 20);
    if (step === this.lastBreathStep) return;
    this.lastBreathStep = step;

    // Notify listeners without re-entering syncBreathTimer's start path
    // unnecessarily — publish handles it and the timer is already running.
    this.state = { ...this.state, breath };
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (err) {
        streamDeck.logger.error("Bridge listener failed", err);
      }
    }
  }
}

/** Process-wide singleton — every action shares one Herdr connection set. */
export const bridge = new HerdrBridge();
