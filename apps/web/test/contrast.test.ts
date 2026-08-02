import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contrast regression test (WCAG 2.1 AA, 4.5:1 for normal text).
 *
 * Parses the :root custom properties and badge/notice rules straight out of
 * app/globals.css — no browser, no CSS pipeline — and computes relative
 * luminance for the foreground/background pairs the UI actually renders.
 * Encodes the measured §0 failures (badge-info 3.82:1, badge-critical and
 * --ink-mute marginal) as permanent regressions guards.
 */

// vitest runs with cwd = apps/web.
const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');

/** Hex custom properties declared on :root, e.g. { '--sand-100': '#f6f3ec' }. */
function parseRootVars(source: string): Record<string, string> {
  const rootBlock = source.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!rootBlock) throw new Error('globals.css: :root block not found');
  const vars: Record<string, string> = {};
  for (const match of rootBlock[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;/g)) {
    vars[match[1]] = match[2].toLowerCase();
  }
  return vars;
}

/** Declarations of a single class rule, e.g. `.badge-info { ... }`. */
function parseRule(source: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!rule) throw new Error(`globals.css: rule ${selector} not found`);
  const body = rule[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const decls: Record<string, string> = {};
  for (const match of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
    decls[match[1]] = match[2].trim();
  }
  return decls;
}

function resolveColor(value: string, vars: Record<string, string>): string {
  const varRef = value.match(/^var\((--[\w-]+)\)$/);
  const hex = varRef ? vars[varRef[1]] : value;
  if (!hex || !/^#[0-9a-f]{3,6}$/.test(hex)) {
    throw new Error(`cannot resolve color: ${value}`);
  }
  return hex;
}

function relativeLuminance(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const channel = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrastRatio(fg: string, bg: string): number {
  const [lighter, darker] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const vars = parseRootVars(css);

/** All badge/notice text pairs: (selector, min ratio). */
const RULE_PAIRS: [selector: string, minRatio: number][] = [
  ['.badge-success', 4.5],
  ['.badge-warning', 4.5],
  ['.badge-critical', 5.0], // was 4.51 — marginal, darkened for safety margin
  ['.badge-info', 4.5],
  ['.badge-neutral', 5.0], // ink-mute text — same safety floor as --ink-mute
  ['.notice', 4.5],
  ['.notice-success', 4.5],
  ['.notice-info', 4.5]
];

/** Raw custom-property pairs rendered as text on these surfaces. */
const VAR_PAIRS: [fgVar: string, bgVar: string, minRatio: number][] = [
  ['--ink', '--sand-100', 4.5],
  ['--ink', '--card', 4.5],
  ['--ink-soft', '--sand-100', 4.5],
  ['--ink-soft', '--card', 4.5],
  ['--ink-soft', '--sand-200', 4.5],
  // --ink-mute was 4.53 on sand-100 — marginal, held to a 5:1 safety floor.
  ['--ink-mute', '--sand-100', 5.0],
  ['--ink-mute', '--sand-50', 5.0],
  ['--ink-mute', '--card', 5.0],
  ['--earth-600', '--sand-100', 4.5], // .kicker / badge-info / module-tag text
  ['--earth-600', '--card', 4.5],
  ['--earth-600', '--sand-200', 4.5],
  ['--green-700', '--card', 4.5], // metric-trend, links on white
  ['--green-700', '--sand-100', 4.5],
  ['--clay-600', '--card', 4.5], // metric-trend.down
  ['--green-300', '--green-950', 4.5], // footer-bottom
  ['--green-100', '--green-950', 4.5], // footer body
  ['--green-200', '--green-900', 4.5] // hero kicker
];

describe('globals.css WCAG AA contrast', () => {
  for (const [selector, min] of RULE_PAIRS) {
    it(`${selector} text/background >= ${min}:1`, () => {
      const rule = parseRule(css, selector);
      const fg = resolveColor(rule.color, vars);
      const bg = resolveColor(rule.background, vars);
      const ratio = contrastRatio(fg, bg);
      expect(
        ratio,
        `${selector}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(min);
    });
  }

  for (const [fgVar, bgVar, min] of VAR_PAIRS) {
    it(`${fgVar} on ${bgVar} >= ${min}:1`, () => {
      const fg = resolveColor(`var(${fgVar})`, vars);
      const bg = resolveColor(`var(${bgVar})`, vars);
      const ratio = contrastRatio(fg, bg);
      expect(
        ratio,
        `${fgVar} (${fg}) on ${bgVar} (${bg}) = ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(min);
    });
  }
});
