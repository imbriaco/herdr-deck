import streamDeck from "@elgato/streamdeck";

import { AgentSlot } from "./actions/agent-slot";
import { HerdStatus } from "./actions/status";
import { bridge } from "./herdr/bridge";

// Trace is noisy; info is enough once the bridge is stable.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new AgentSlot());
streamDeck.actions.registerAction(new HerdStatus());

// Kick the bridge as soon as the plugin process is up, so the first key that
// appears already has fresh agent state waiting.
bridge.start();

streamDeck.connect();
