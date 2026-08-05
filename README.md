# Herd Deck

Stream Deck bridge for [Herdr](https://herdr.dev) — shamelessly inspired by
Scott Chacon's [micro-manager](https://github.com/schacon/micro-manager) for the
Work Louder Creator Micro 2.

Each **Agent Slot** key lights with that agent's status and shows its short
name. Press it to focus the agent and bring your terminal forward. **Herd
Status** is the across-the-room light: worst state wins.

## Layout (classic 15-key)

**Top two rows are Herdr. Bottom row is yours.**

```
┌────┬────┬────┬────┬────┐
│ 1  │ 2  │ 3  │ 4  │ 5  │  ← agent slots 1–5
├────┼────┼────┼────┼────┤
│ 6  │ 7  │ 8  │ 9  │ ST │  ← slots 6–9 + Herd Status
├────┼────┼────┼────┼────┤
│    │    │    │    │    │  ← keep for other stuff
└────┴────┴────┴────┴────┘
```

Drop nine **Agent Slot** actions (set Slot to 1…9 in the property inspector)
and one **Herd Status** on the top two rows. Leave the bottom alone.

## Status colours

| colour | meaning |
|--------|---------|
| red    | blocked — needs you |
| amber  | working |
| blue   | done — finished, not yet focused |
| green  | idle — finished and seen |
| grey   | empty slot |
| dark   | Herdr offline |

Focused agents get a white border.

## Develop

```bash
npm install
npm run build
npm run link          # once: symlink into Stream Deck's Plugins folder
npm run watch         # rebuild + restart on change
```

Requires Stream Deck software ≥ 7.1 and a running Herdr server.

## Config

| variable | default | purpose |
|----------|---------|---------|
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | Herdr API socket |
| `HERDR_TERMINAL_BUNDLE_ID` | `com.mitchellh.ghostty` | terminal to raise on focus |

Stream Deck launches the plugin, so env vars need to be visible to that
process (launchd / `launchctl setenv`, or set them later via a config file).

## Launch Workspace

Drop a **Launch Workspace** action and set:

| field | example | purpose |
|-------|---------|---------|
| Name | `my-app` | Button label + Herdr workspace label |
| Path | `~/src/my-app` | Shell cwd (`~` expanded) |
| Agent | `claude` (optional) | Start this agent in the new pane; empty = shell only |

Press → `workspace.create` (focused) → optional `agent.start` → raise terminal.

## Roadmap

- [x] Agent slots + focus + raise terminal
- [x] Aggregate status key
- [x] Blocked breathing
- [x] Workspace labels + agent glyphs
- [x] Launch workspace (path + optional agent)
- [ ] More Herdr controls (as needed)
