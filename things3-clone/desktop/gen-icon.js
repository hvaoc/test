// Generate a crisp, transparent macOS app icon (rounded-square + checkmark) with
// supersampled anti-aliasing. Avoids QuickLook's thumbnail framing that made the
// icon look "jailed". Run: node desktop/gen-icon.js  → writes desktop/build/appicon.png
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const OUT = process.argv[2] || path.join(__dirname, 'build', 'appicon.png');
const N = 1024;            // final icon size
const SS = 3;              // supersample factor (3x3 per final pixel)
const S = N * SS;

// macOS icon grid: rounded square ~80% of the canvas, centered, transparent margin.
const margin = 100 * SS;
const x0 = margin, y0 = margin, x1 = S - margin, y1 = S - margin;
const r = 185 * SS;        // corner radius
const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
const halfW = (x1 - x0) / 2, halfH = (y1 - y0) / 2;

// Vertical gradient: #5b95ff (top) -> #2b6fff (bottom).
const top = [91, 149, 255], bot = [43, 111, 255];

// Checkmark polyline (in the 512 SVG tile space) mapped into the canvas tile.
const svgTile0 = 48, svgTileW = 416;           // logo.svg rect: x 48..464
const scale = (x1 - x0) / svgTileW * 1;         // tile px per svg unit
const off = x0 - svgTile0 * scale;
const map = (px, py) => [px * scale + off, py * scale + off];
const P = [map(168, 262), map(224, 320), map(346, 178)];
const halfStroke = (42 / 2) * scale;

function insideRR(px, py) {
  const dx = Math.abs(px - cx) - (halfW - r);
  const dy = Math.abs(py - cy) - (halfH - r);
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0);
  const outside = Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
  return outside <= 0;
}
function distSeg(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = px - a[0], wy = py - a[1];
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  const dx = px - (a[0] + t * vx), dy = py - (a[1] + t * vy);
  return Math.hypot(dx, dy);
}
function onCheck(px, py) {
  const d = Math.min(distSeg(px, py, P[0], P[1]), distSeg(px, py, P[1], P[2]));
  return d <= halfStroke;
}

const png = new PNG({ width: N, height: N });
const samples = SS * SS;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let rr = 0, gg = 0, bb = 0, aa = 0;
    for (let sj = 0; sj < SS; sj++) {
      for (let si = 0; si < SS; si++) {
        const sx = x * SS + si + 0.5;
        const sy = y * SS + sj + 0.5;
        if (!insideRR(sx, sy)) continue;
        aa += 1;
        if (onCheck(sx, sy)) { rr += 255; gg += 255; bb += 255; }
        else {
          const t = Math.max(0, Math.min(1, (sy - y0) / (y1 - y0)));
          rr += top[0] + (bot[0] - top[0]) * t;
          gg += top[1] + (bot[1] - top[1]) * t;
          bb += top[2] + (bot[2] - top[2]) * t;
        }
      }
    }
    const idx = (y * N + x) << 2;
    const alpha = aa / samples;
    // Colours are averaged over the *covered* subsamples so edges stay crisp.
    png.data[idx] = aa ? Math.round(rr / aa) : 0;
    png.data[idx + 1] = aa ? Math.round(gg / aa) : 0;
    png.data[idx + 2] = aa ? Math.round(bb / aa) : 0;
    png.data[idx + 3] = Math.round(alpha * 255);
  }
}
fs.writeFileSync(OUT, PNG.sync.write(png));
console.log('wrote', OUT, N + 'x' + N);
