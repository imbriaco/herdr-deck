import { execFile } from "node:child_process";
import { promisify } from "node:util";

import streamDeck from "@elgato/streamdeck";

const execFileAsync = promisify(execFile);

/** Default terminal Herdr panes live in. Override with HERDR_TERMINAL_BUNDLE_ID. */
export const DEFAULT_TERMINAL_BUNDLE_ID = "com.mitchellh.ghostty";

/**
 * Bring the terminal forward if it is already running.
 *
 * Herdr selects the pane but leaves the window wherever it was in the z-order,
 * so an agent key pressed from a browser used to move a cursor you could not
 * see. We never launch a fresh terminal — if the bundle id is wrong, opening
 * a new window is not what the key meant.
 */
export async function raiseTerminal(
  bundleId = process.env.HERDR_TERMINAL_BUNDLE_ID || DEFAULT_TERMINAL_BUNDLE_ID,
): Promise<void> {
  if (process.platform !== "darwin") return;

  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      `tell application "System Events" to (bundle identifier of processes) contains "${bundleId}"`,
    ]);
    if (stdout.trim() !== "true") {
      streamDeck.logger.debug(`Terminal ${bundleId} is not running; not launching`);
      return;
    }
    await execFileAsync("osascript", [
      "-e",
      `tell application id "${bundleId}" to activate`,
    ]);
  } catch (err) {
    streamDeck.logger.warn("Failed to raise terminal", err);
  }
}
