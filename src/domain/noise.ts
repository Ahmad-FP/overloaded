/** Dave Hoskins hash + ridged FBM from ZyFou/ProceduralTerrains terrainGLSL.js (MIT). */

const fract = (n: number) => n - Math.floor(n);

export const hash12 = (x: number, y: number) => {
  let px = fract(x * 0.1031);
  let py = fract(y * 0.1031);
  let pz = fract(x * 0.1031);
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d;
  py += d;
  pz += d;
  return fract((px + py) * pz);
};

const quintic = (f: number) => f * f * f * (f * (f * 6 - 15) + 10);

export const vnoise = (x: number, y: number) => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ux = quintic(x - ix);
  const uy = quintic(y - iy);
  const a = hash12(ix, iy);
  const b = hash12(ix + 1, iy);
  const c = hash12(ix, iy + 1);
  const d = hash12(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
};

/** Ridged multifractal. Persistence 0.5, lacunarity 2, ROT2 from terrainGLSL. */
export const ridgedFbm = (x: number, y: number, octaves = 4) => {
  let amp = 0.5;
  let sum = 0;
  let norm = 0;
  let carry = 1;
  let px = x;
  let py = y;
  for (let i = 0; i < octaves; i += 1) {
    let v = 1 - Math.abs(vnoise(px, py) * 2 - 1);
    v = v * v;
    sum += amp * v * carry;
    carry = Math.min(1, Math.max(0, v * 1.4));
    norm += amp;
    amp *= 0.5;
    const nx = 0.8 * px - 0.6 * py;
    const ny = 0.6 * px + 0.8 * py;
    px = nx * 2;
    py = ny * 2;
  }
  return sum / Math.max(norm, 1e-4);
};
