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

/** Scale RGB toward black by brightness in 0..1 (Stream Deck “breathing”). */
function scaleColor(color: number, brightness: number): number {
  const b = Math.max(0, Math.min(1, brightness));
  const r = Math.round(((color >> 16) & 0xff) * b);
  const g = Math.round(((color >> 8) & 0xff) * b);
  const bl = Math.round((color & 0xff) * b);
  return (r << 16) | (g << 8) | bl;
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
 *
 * `brightness` dims the fill (used for blocked breathing). Defaults to full.
 */
export function keyFace(opts: {
  status: AgentStatus | "empty" | "offline";
  focused?: boolean;
  /** Drawn near the top of the key; empty string = colour only. */
  label?: string;
  /** 0..1 fill brightness. Blocked keys pulse this. */
  brightness?: number;
}): string {
  const base = STATUS_COLORS[opts.status];
  const brightness = opts.brightness ?? 1;
  const fill = hex(scaleColor(base, brightness));
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
