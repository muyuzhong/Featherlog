import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Keep platform icons in the package so end users do not need an image converter.
const source = fileURLToPath(new URL('../resources/icon.png', import.meta.url));
const ico = fileURLToPath(new URL('../resources/icon.ico', import.meta.url));
execFileSync('magick', [source, '-define', 'icon:auto-resize=256,128,64,48,32,16', ico]);
assert.equal(readFileSync(ico).readUInt16LE(2), 1);
const chunks = [];
for (const [type, size] of [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
  const png = execFileSync('magick', [source, '-resize', `${size}x${size}`, 'png:-']);
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
  const header = Buffer.alloc(8);
  header.write(type);
  header.writeUInt32BE(png.length + 8, 4);
  chunks.push(header, png);
}
const header = Buffer.alloc(8);
header.write('icns');
header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
writeFileSync(new URL('../resources/icon.icns', import.meta.url), Buffer.concat([header, ...chunks]));
