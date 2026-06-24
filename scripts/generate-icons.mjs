/**
 * Generate app icons for OpenCode Quota.
 *
 * Creates a 512x512 PNG with a "Q" design on a blue gradient background.
 * electron-builder will auto-generate .icns (macOS) and .ico (Windows) from this PNG.
 *
 * Run: node scripts/generate-icons.mjs
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = join(__dirname, "..", "build");
const iconPath = join(buildDir, "icon.png");
const iconsDir = join(buildDir, "icons");

const SIZE = 512;

// =============================================================================
// PNG encoder (minimal, no dependencies)
// =============================================================================

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPng(width, height, pixels) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = createChunk("IHDR", ihdr);

  // IDAT chunk (raw pixel data with filter byte per row)
  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter: none
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rawData.push(pixels[idx]);     // R
      rawData.push(pixels[idx + 1]); // G
      rawData.push(pixels[idx + 2]); // B
      rawData.push(pixels[idx + 3]); // A
    }
  }

  // Simple deflate (store method, no compression — good enough for build tool)
  const deflated = deflateRaw(Buffer.from(rawData));
  const idatChunk = createChunk("IDAT", deflated);

  // IEND chunk
  const iendChunk = createChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crcValue = Buffer.alloc(4);
  crcValue.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuffer, data, crcValue]);
}

function deflateRaw(data) {
  // Minimal deflate "stored" block (no compression)
  // This is valid for PNG and works without zlib dependency
  const chunks = [];
  const MAX_BLOCK = 65535;

  for (let offset = 0; offset < data.length; offset += MAX_BLOCK) {
    const blockSize = Math.min(MAX_BLOCK, data.length - offset);
    const isLast = offset + blockSize >= data.length;

    // Block header: BFINAL (1 bit) + BTYPE=00 (2 bits) = 0x00 or 0x01
    chunks.push(isLast ? 0x01 : 0x00);

    // LEN and NLEN (2 bytes each, little-endian)
    const len = Buffer.alloc(2);
    len.writeUInt16LE(blockSize, 0);
    const nlen = Buffer.alloc(2);
    nlen.writeUInt16LE(blockSize ^ 0xffff, 0);

    chunks.push(len[0], len[1], nlen[0], nlen[1]);

    // Data
    for (let i = offset; i < offset + blockSize; i++) {
      chunks.push(data[i]);
    }
  }

  // zlib header (CMF=0x78, FLG=0x01) + blocks + adler32 checksum
  const adler = adler32(data);
  const adlerBuf = Buffer.alloc(4);
  adlerBuf.writeUInt32BE(adler, 0);

  return Buffer.from([0x78, 0x01, ...chunks, adlerBuf[0], adlerBuf[1], adlerBuf[2], adlerBuf[3]]);
}

function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// =============================================================================
// Icon design
// =============================================================================

function createIconPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Rounded rect background
      const cornerRadius = size * 0.2;
      const inRect = isInRoundedRect(x, y, size, size, cornerRadius);

      if (inRect) {
        // Gradient background (blue-purple)
        const t = y / size;
        pixels[idx] = Math.round(60 + t * 40);     // R
        pixels[idx + 1] = Math.round(100 + t * 40); // G
        pixels[idx + 2] = Math.round(180 + t * 40); // B
        pixels[idx + 3] = 255;                       // A
      } else {
        pixels[idx + 3] = 0; // transparent
      }
    }
  }

  // Draw "Q" letter shape in white
  const fontSize = size * 0.45;
  drawQ(pixels, size, cx - fontSize * 0.45, cy - fontSize * 0.35, fontSize);

  return pixels;
}

function isInRoundedRect(x, y, w, h, r) {
  // Outside the rectangle bounds
  if (x < 0 || x >= w || y < 0 || y >= h) return false;

  // Corners: check if outside the rounded corner
  const corners = [
    { cx: r, cy: r },                     // top-left
    { cx: w - r - 1, cy: r },             // top-right
    { cx: r, cy: h - r - 1 },             // bottom-left
    { cx: w - r - 1, cy: h - r - 1 },     // bottom-right
  ];

  for (const { cx: cornerX, cy: cornerY } of corners) {
    if (
      (x < r && y < r) ||
      (x >= w - r && y < r) ||
      (x < r && y >= h - r) ||
      (x >= w - r && y >= h - r)
    ) {
      const dx = x - cornerX;
      const dy = y - cornerY;
      if (Math.sqrt(dx * dx + dy * dy) > r) return false;
    }
  }

  return true;
}

function drawQ(pixels, size, ox, oy, fontSize) {
  const thickness = fontSize * 0.18;

  // Draw the "O" part of Q (circle)
  const circleCx = ox + fontSize * 0.5;
  const circleCy = oy + fontSize * 0.45;
  const outerR = fontSize * 0.42;
  const innerR = outerR - thickness;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - circleCx;
      const dy = y - circleCy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= outerR && dist >= innerR) {
        // Check if this point is NOT in the tail area (bottom-right gap for Q tail)
        const angle = Math.atan2(dy, dx);
        // Gap for the tail: between -45° and -20° (bottom-right)
        const tailAngle = -0.5; // ~ -30°
        const tailWidth = 0.25;

        if (!(angle > tailAngle - tailWidth && angle < tailAngle + tailWidth && dist > innerR - thickness * 0.5)) {
          const idx = (Math.round(y) * size + Math.round(x)) * 4;
          pixels[idx] = 255;
          pixels[idx + 1] = 255;
          pixels[idx + 2] = 255;
          pixels[idx + 3] = 255;
        }
      }
    }
  }

  // Draw the Q tail (diagonal stroke from bottom-right of circle)
  const tailStartX = circleCx + Math.cos(-0.5) * outerR * 0.85;
  const tailStartY = circleCy + Math.sin(-0.5) * outerR * 0.85;
  const tailEndX = tailStartX + fontSize * 0.35;
  const tailEndY = tailStartY + fontSize * 0.35;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = distToLineSegment(x, y, tailStartX, tailStartY, tailEndX, tailEndY);
      if (dist < thickness * 0.7) {
        const idx = (y * size + x) * 4;
        pixels[idx] = 255;
        pixels[idx + 1] = 255;
        pixels[idx + 2] = 255;
        pixels[idx + 3] = 255;
      }
    }
  }
}

function distToLineSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);

  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const nearX = x1 + t * dx;
  const nearY = y1 + t * dy;
  return Math.sqrt((px - nearX) ** 2 + (py - nearY) ** 2);
}

// =============================================================================
// Main
// =============================================================================

function main() {
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(iconsDir, { recursive: true });

  console.log("Generating app icon...");
  const pixels = createIconPixels(SIZE);
  const png = createPng(SIZE, SIZE, pixels);

  writeFileSync(iconPath, png);
  console.log(`  Created ${iconPath} (${SIZE}x${SIZE} PNG)`);

  // Generate smaller sizes for Linux
  const linuxSizes = [16, 22, 24, 32, 48, 64, 96, 128, 256];
  for (const s of linuxSizes) {
    // Simple nearest-neighbor downscale
    const smallPixels = Buffer.alloc(s * s * 4);
    const scale = SIZE / s;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const srcX = Math.floor(x * scale);
        const srcY = Math.floor(y * scale);
        const srcIdx = (srcY * SIZE + srcX) * 4;
        const dstIdx = (y * s + x) * 4;
        smallPixels[dstIdx] = pixels[srcIdx];
        smallPixels[dstIdx + 1] = pixels[srcIdx + 1];
        smallPixels[dstIdx + 2] = pixels[srcIdx + 2];
        smallPixels[dstIdx + 3] = pixels[srcIdx + 3];
      }
    }
    const smallPng = createPng(s, s, smallPixels);
    const smallPath = join(iconsDir, `${s}x${s}.png`);
    writeFileSync(smallPath, smallPng);
    console.log(`  Created ${smallPath} (${s}x${s})`);
  }

  console.log("Icon generation complete!");
}

main();
