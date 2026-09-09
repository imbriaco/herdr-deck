import {
  STATUS_COLORS,
  type AgentStatus,
} from "../herdr/status";

/**
 * Key faces as SVG (Stream Deck accepts SVG via setImage). Baking the label
 * into the image gives reliable top placement — setTitle alignment is flaky
 * once a key has been customized in the profile.
 *
 * Glyphs are filled shapes only (no strokes, no multi-subpath `d` attrs).
 * Stream Deck's SVG rasterizer quietly dies on stroke-heavy paths and leaves
 * a broken “chip” face — seen with the first claude/grok mock.
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
 * Small white-on-colour marks in the lower third.
 * Absolute coordinates only; filled geometry only.
 */
function agentGlyphSvg(agent: string | undefined): string {
  if (!agent) return "";
  const kind = agent.toLowerCase();
  // Anchor: centre of lower third.
  const cx = 72;
  const cy = 108;
  const w = 'fill="#ffffff" fill-opacity="0.95"';

  switch (kind) {
    case "claude":
      // Four-point sparkle as a filled star (no strokes).
      return `<path ${w} d="M${cx} ${cy - 16} L${cx + 4} ${cy - 4} L${cx + 16} ${cy} L${cx + 4} ${cy + 4} L${cx} ${cy + 16} L${cx - 4} ${cy + 4} L${cx - 16} ${cy} L${cx - 4} ${cy - 4} Z"/>`;

    case "codex": {
      // Thick chevrons as filled polygons (not stroked polylines).
      const L = `<path ${w} d="M${cx - 6} ${cy - 14} L${cx - 18} ${cy} L${cx - 6} ${cy + 14} L${cx - 12} ${cy} Z"/>`;
      const R = `<path ${w} d="M${cx + 6} ${cy - 14} L${cx + 18} ${cy} L${cx + 6} ${cy + 14} L${cx + 12} ${cy} Z"/>`;
      return L + R;
    }

    case "grok": {
      // Bold X as two filled rhombi (rotated bars).
      // Vertical-ish diagonals approximated with thick parallelograms.
      const a = `<path ${w} d="M${cx - 14} ${cy - 12} L${cx - 8} ${cy - 16} L${cx + 14} ${cy + 12} L${cx + 8} ${cy + 16} Z"/>`;
      const b = `<path ${w} d="M${cx + 8} ${cy - 16} L${cx + 14} ${cy - 12} L${cx - 8} ${cy + 16} L${cx - 14} ${cy + 12} Z"/>`;
      return a + b;
    }

    case "gemini": {
      const a = `<path ${w} d="M${cx - 8} ${cy} L${cx} ${cy - 12} L${cx + 8} ${cy} L${cx} ${cy + 12} Z"/>`;
      const b = `<path ${w} fill-opacity="0.55" d="M${cx} ${cy} L${cx + 8} ${cy - 12} L${cx + 16} ${cy} L${cx + 8} ${cy + 12} Z"/>`;
      return a + b;
    }

    default:
      // Filled disc for unknown agents.
      return `<circle ${w} cx="${cx}" cy="${cy}" r="11"/>`;
  }
}

/**
 * Solid status colour with optional focus ring, label near the top, and a
 * small agent glyph in the lower third.
 *
 * `brightness` dims the fill (used for blocked breathing). Defaults to full.
 */
export function keyFace(opts: {
  status?: AgentStatus | "empty" | "offline";
  /** Override fill colour (e.g. launch keys) — packed 0xRRGGBB. */
  color?: number;
  focused?: boolean;
  /** Drawn near the top of the key; empty string = colour only. */
  label?: string;
  /** Second line under `label` (e.g. tab name). */
  sublabel?: string;
  /** Agent type for the bottom glyph (claude, codex, grok, …). */
  agent?: string;
  /** 0..1 fill brightness. Blocked keys pulse this. */
  brightness?: number;
}): string {
  const base = opts.color ?? STATUS_COLORS[opts.status ?? "empty"];
  const brightness = opts.brightness ?? 1;
  const fill = hex(scaleColor(base, brightness));
  const focused = opts.focused === true;
  const label = (opts.label ?? "").trim();
  const sublabel = (opts.sublabel ?? "").trim();

  // Focus ring: filled frame (outer white rect minus inner hole via two rects
  // is hard in basic SVG; use a simple thick rounded rect stroke — Stream Deck
  // handles a single stroke on a rect more reliably than path strokes.
  const border = focused
    ? `<rect x="6" y="6" width="${SIZE - 12}" height="${SIZE - 12}" rx="14" ry="14" fill="none" stroke="#ffffff" stroke-width="8"/>`
    : "";

  const text = labelSvg(label, sublabel);

  const glyph = agentGlyphSvg(opts.agent);

  // Keep the document boring: no XML prolog, no transforms, no CSS.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="18" ry="18" fill="${fill}"/>` +
    border +
    text +
    glyph +
    `</svg>`;

  // base64 is more reliable than encodeURIComponent for Stream Deck's loader.
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function labelSvg(label: string, sublabel: string): string {
  if (!label) return "";
  const family =
    'font-family="Helvetica, Arial, sans-serif" text-anchor="middle" dominant-baseline="central" fill="#ffffff"';
  const x = SIZE / 2;
  if (!sublabel) {
    return `<text x="${x}" y="40" ${family} font-size="23" font-weight="700">${escapeXml(label)}</text>`;
  }
  return (
    `<text x="${x}" y="28" ${family} font-size="23" font-weight="700">${escapeXml(label)}</text>` +
    `<text x="${x}" y="52" ${family} font-size="22" font-weight="600" fill-opacity="0.88">${escapeXml(sublabel)}</text>`
  );
}

/** @deprecated Prefer keyFace — kept for any leftover solid-only call sites. */
export function imageForStatus(
  status: AgentStatus | "empty" | "offline",
  focused = false,
): string {
  return keyFace({ status, focused });
}
