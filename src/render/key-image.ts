import {
  STATUS_COLORS,
  type AgentStatus,
} from "../herdr/status";

/**
 * Key faces as SVG (Stream Deck accepts SVG via setImage). Baking the label
 * into the image gives reliable top placement — setTitle alignment is flaky
 * once a key has been customized in the profile.
 */

const SIZE = 144;

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Solid status colour with optional focus ring and a label near the top
 * (one blank line of padding above the text).
 */
export function keyFace(opts: {
  status: AgentStatus | "empty" | "offline";
  focused?: boolean;
  /** Drawn near the top of the key; empty string = colour only. */
  label?: string;
}): string {
  const color = STATUS_COLORS[opts.status];
  const fill = hex(color);
  const focused = opts.focused === true;
  const label = (opts.label ?? "").trim();

  // ~one line of padding from the top edge before the name.
  const labelY = 40;
  const border = focused
    ? `<rect x="4" y="4" width="${SIZE - 8}" height="${SIZE - 8}" rx="16" ry="16" fill="none" stroke="#ffffff" stroke-width="10"/>`
    : "";

  const text = label
    ? `<text x="${SIZE / 2}" y="${labelY}" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" font-family="-apple-system, system-ui, sans-serif" font-size="26" font-weight="600">${escapeXml(label)}</text>`
    : "";

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="18" ry="18" fill="${fill}"/>
  ${border}
  ${text}
</svg>`;

  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

/** @deprecated Prefer keyFace — kept for any leftover solid-only call sites. */
export function imageForStatus(
  status: AgentStatus | "empty" | "offline",
  focused = false,
): string {
  return keyFace({ status, focused });
}
