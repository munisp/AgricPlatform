import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Design tokens v2 guards (Wave UIUX).
 *
 * - The spacing/radius/shadow/type scales stay declared and coherent.
 * - Brand guard: no blue/purple hues in the :root palette — this is an
 *   agriculture platform (warm greens, ochres, clay), never Material blue.
 * - Focus-visible and 44px touch-target guarantees stay in the stylesheet.
 */

// vitest runs with cwd = apps/web.
const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');

function rootVars(source: string): Record<string, string> {
  const rootBlock = source.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!rootBlock) throw new Error('globals.css: :root block not found');
  const vars: Record<string, string> = {};
  for (const match of rootBlock[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[match[1]] = match[2].trim();
  }
  return vars;
}

/** hex (#rgb/#rrggbb) → hue in degrees [0, 360). */
function hue(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let out: number;
  if (max === r) out = 60 * (((g - b) / delta) % 6);
  else if (max === g) out = 60 * ((b - r) / delta + 2);
  else out = 60 * ((r - g) / delta + 4);
  return (out + 360) % 360;
}

function saturation(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

const vars = rootVars(css);

describe('design tokens v2', () => {
  it('declares the full spacing scale on the 4/8pt rhythm', () => {
    const expected: Record<string, string> = {
      '--space-1': '4px',
      '--space-2': '8px',
      '--space-3': '12px',
      '--space-4': '16px',
      '--space-5': '24px',
      '--space-6': '32px',
      '--space-7': '48px',
      '--space-8': '64px'
    };
    for (const [name, value] of Object.entries(expected)) {
      expect(vars[name], name).toBe(value);
      expect(parseInt(value, 10) % 4).toBe(0);
    }
  });

  it('declares radius, shadow and type scales without removing v1 names', () => {
    for (const name of [
      '--radius-s',
      '--radius-m',
      '--radius-l',
      '--radius-full',
      '--shadow-s',
      '--shadow-m',
      '--shadow-l',
      '--shadow-focus',
      '--text-xs',
      '--text-sm',
      '--text-base',
      '--text-lg',
      '--text-xl',
      '--text-2xl',
      '--text-3xl',
      '--content-max',
      '--target-min'
    ]) {
      expect(vars[name], name).toBeTruthy();
    }
    expect(vars['--radius-full']).toBe('999px');
    expect(vars['--target-min']).toBe('44px');
  });

  it('brand guard: no blue or purple hues in the :root palette', () => {
    const hexVars = Object.entries(vars).filter(([, value]) => /^#[0-9a-f]{3,6}$/i.test(value));
    expect(hexVars.length).toBeGreaterThan(10);
    for (const [name, value] of hexVars) {
      const sat = saturation(value);
      if (sat < 0.08) continue; // near-neutrals carry no hue signal
      const h = hue(value);
      // Blue → purple band. Warm greens (~80–160), ochres and clay stay.
      expect(h >= 200 && h <= 300, `${name} ${value} has hue ${h.toFixed(0)}°`).toBe(false);
    }
  });

  it('keeps a strong focus-visible treatment', () => {
    const focusRule = css.match(/:focus-visible\s*\{([^}]*)\}/);
    expect(focusRule).toBeTruthy();
    expect(focusRule![1]).toContain('outline: 3px solid var(--focus)');
  });

  it('keeps 44px minimum touch targets on interactive primitives', () => {
    // Buttons, chips, nav links, inputs and bottom tabs all declare the floor.
    const occurrences = css.match(/min-height:\s*(44px|var\(--target-min\))/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(6);
    expect(css).toContain('--target-min: 44px');
  });
});
