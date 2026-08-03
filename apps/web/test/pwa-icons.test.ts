import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static guards for the generated PWA raster icons (produced by
 * `npm run icons:generate` from public/icon.svg and committed as real
 * binary assets). Asserts the files the manifest and root-layout metadata
 * reference actually exist, are valid PNGs and carry the exact pixel
 * dimensions they declare — installability breaks silently otherwise.
 */

// vitest runs with cwd = apps/web.
const pub = (name: string) => resolve(process.cwd(), 'public', name);

function pngSize(file: string) {
  const buf = readFileSync(pub(file));
  // PNG magic: 8-byte signature, then IHDR length+type, then width/height.
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect(
    [...buf.subarray(0, 8)],
    `${file} is not a PNG`
  ).toEqual(PNG_MAGIC);
  expect(buf.toString('ascii', 12, 16)).toBe('IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf.readUInt8(25)
  };
}

describe('generated PWA icons', () => {
  it('ships a 192x192 PNG for purpose "any"', () => {
    expect(pngSize('icon-192.png')).toMatchObject({ width: 192, height: 192 });
  });

  it('ships a 512x512 PNG for purpose "any"', () => {
    expect(pngSize('icon-512.png')).toMatchObject({ width: 512, height: 512 });
  });

  it('ships dedicated maskable PNGs at 192 and 512', () => {
    expect(pngSize('icon-maskable-192.png')).toMatchObject({ width: 192, height: 192 });
    expect(pngSize('icon-maskable-512.png')).toMatchObject({ width: 512, height: 512 });
  });

  it('ships a 180x180 apple-touch-icon without an alpha channel (iOS requirement)', () => {
    const meta = pngSize('apple-touch-icon.png');
    expect(meta).toMatchObject({ width: 180, height: 180 });
    // color type 2 = truecolor RGB (flattened); 6 would be RGBA.
    expect(meta.colorType).toBe(2);
  });

  it('every manifest icon src resolves to a real file in public/', () => {
    const manifest = JSON.parse(
      readFileSync(pub('manifest.webmanifest'), 'utf8')
    ) as { icons: { src: string }[] };
    for (const icon of manifest.icons) {
      const file = icon.src.replace(/^\//, '');
      expect(existsSync(pub(file)), `${icon.src} missing from public/`).toBe(true);
    }
  });
});
