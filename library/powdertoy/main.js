import { DEFAULT_MATERIALS } from "./materials.js";

const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
const lerp = (a, b, t) => a + (b - a) * t;

function hexToRgb(hex) {
  const h = hex.replace("#", "").trim();
  const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Small deterministic PRNG (mulberry32) factory
function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Simple "thermal" gradient for overlay: cold->hot
function tempColor(tC) {
  // Map -50..300 to 0..1
  const x = clamp((tC + 50) / 350, 0, 1);
  // blue -> cyan -> yellow -> red
  const r = Math.round(lerp(40, 255, clamp((x - 0.5) / 0.5, 0, 1)));
  const g = Math.round(lerp(80, 255, x < 0.5 ? x * 2 : 1 - (x - 0.5) * 1.2));
  const b = Math.round(lerp(255, 20, x));
  return { r, g, b };
}

function pressureColor(p) {
  // Map -1..+1 to 0..255 grayscale
  const x = clamp((p + 1) / 2, 0, 1);
  const v = Math.round(x * 255);
  return { r: v, g: v, b: v };
}

class Sandbox {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });

    this.w = opts.w;
    this.h = opts.h;
    this.cellSize = opts.cellSize;

    this.canvas.width = this.w;
    this.canvas.height = this.h;

    const n = this.w * this.h;

    this.mat = new Uint16Array(n);      // material id (0=air)
    this.temp = new Float32Array(n);    // temperature in °C
    this.temp2 = new Float32Array(n);
    this.press = new Float32Array(n);   // arbitrary pressure units
    this.press2 = new Float32Array(n);

    this.updated = new Uint8Array(n);   // for move pass
    // entities (neutrons or other future spawned particles)
    this.entities = []; // {x,y,matId,life,age,dirX,dirY}

    this.tick = 0;
    this.paused = false;

    this.gravity = 1.10;
    this.ambientT = 20;

    this.showTemp = false;
    this.showPressure = false;
    this.overlayAlpha = 0.55;

    // display mode: 'regular' | 'fancy' (bloom based on temperature)
    this.displayMode = 'regular';

    // offscreen canvas for bloom/glow pass
    this._glowCanvas = document.createElement('canvas');
    this._glowCanvas.width = this.w;
    this._glowCanvas.height = this.h;
    this._glowCtx = this._glowCanvas.getContext('2d');

    this.materials = structuredClone(DEFAULT_MATERIALS);
    this.materialsById = new Map(this.materials.map(m => [m.id, m]));
    // name -> material quick lookup (plain object for easy indexing)
    this.materialsByName = Object.fromEntries(this.materials.map(m => [m.name, m]));
    this.resetTemps();

    // color seed / deterministic per-cell noise to keep pixel colors constant
    this.colorSeed = Number(opts.seed ?? 123456789) >>> 0;
    this._cellNoise = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const rng = mulberry32((this.colorSeed + i) >>> 0);
      this._cellNoise[i] = rng() - 0.5; // store in [-0.5,0.5]
    }
  }

  resetTemps() {
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) this.temp[i] = this.ambientT;
  }

  idx(x, y) { return x + y * this.w; }
  inb(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }

  getMat(id) { return this.materialsById.get(id) || this.materialsById.get(0); }

  clear() {
    this.mat.fill(0);
    this.resetTemps();
    this.press.fill(0);
  }

  setAmbientT(v) {
    this.ambientT = v;
  }

  paintCircle(cx, cy, r, matId, mode, intensity=1) {
    // mode: "paint" | "erase" | "heat" | "cool"
    const r2 = r * r;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx*dx + dy*dy > r2) continue;
        if (!this.inb(x, y)) continue;
        const i = this.idx(x, y);

        if (mode === "erase") {
          // remove material and any entity at that cell
          this.mat[i] = 0;
          this.temp[i] = this.ambientT;
          for (let ei = this.entities.length - 1; ei >= 0; ei--) {
            const e = this.entities[ei];
            if (Math.floor(e.x) === x && Math.floor(e.y) === y) this.entities.splice(ei, 1);
          }
          this.updated[i] = 1;
        } else if (mode === "paint") {
          this.mat[i] = matId;
          const m = this.getMat(matId);
          if (m && m.defaultTemp != null) this.temp[i] = m.defaultTemp;
          // spawn an entity if this material defines a behavior (e.g., neutron/emitter)
          if (m && m.behavior) {
            const life = (m.behaviorParams && Number(m.behaviorParams.lifetime)) || 0;
            const ent = { x, y, matId: m.id, age: 0 };
            if (life > 0) ent.life = life;
            this.entities.push(ent);
          }
          this.updated[i] = 1;
        } else if (mode === "heat") {
          this.temp[i] += 6 * intensity;
        } else if (mode === "cool") {
          this.temp[i] -= 6 * intensity;
        }
      }
    }
  }

  // --- Core update ---
  step(dtSeconds) {
    this.tick++;

    // Clear updated marks
    this.updated.fill(0);

    // Apply per-cell sources + decay + phase changes + movement
    // We do separate passes for solids/liquids (bottom-up) and gases (top-down).
    this.applyChemistry(dtSeconds);
    this.updateSolidsAndLiquids(dtSeconds);
    this.updateGases(dtSeconds);
    this.applyEntityBehaviors(dtSeconds);

    // Update pressure field (derived + diffused)
    this.updatePressure(dtSeconds);

    // Update temperature diffusion
    this.updateTemperature(dtSeconds);
  }

  // Entity behavior system
  applyEntityBehaviors(dt) {
    if (!this.entities || this.entities.length === 0) return;
    // iterate entities by index (allow removal)
    for (let ei = this.entities.length - 1; ei >= 0; ei--) {
      const ent = this.entities[ei];
      const m = this.getMat(ent.matId);
      ent.age++;
      if (ent.life && ent.age > ent.life) {
        this.entities.splice(ei, 1);
        continue;
      }
      if (!m || !m.behavior) continue;
      // call behavior handler if exists
      const handler = Sandbox.behaviors && Sandbox.behaviors[m.behavior];
      if (typeof handler === 'function') {
        // provide a small context object
        const ctx = {
          sim: this,
          ent,
          ei,
          tick: this.tick,
          params: m.behaviorParams || {}
        };
        handler(ctx);
      }
    }
  }

  // Trigger an explosion at (x,y). Converts nearby cells to `Fire` and boosts local pressure.
  triggerExplosion(x, y, opts = {}) {
    const radius = opts.radius ?? 5;
    const strength = opts.strength ?? 6;
    const fireId = this.materials.find(m => m.name === 'Fire')?.id ?? 15;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx, ny = y + dy;
        if (!this.inb(nx, ny)) continue;
        const d2 = Math.abs(dx) + Math.abs(dy);
        if (d2 > radius) continue;
        const i = this.idx(nx, ny);
        // convert non-solid cells to fire; heavily heat surroundings
        const matHere = this.getMat(this.mat[i]);
        if (!matHere || matHere.state !== 'solid') {
          this.mat[i] = fireId;
        }
        this.temp[i] += strength * (1 + (radius - d2) * 0.25);
        // increase pressure locally (will be diffused later)
        this.press[i] = Math.max(this.press[i], (this.press[i] || 0) + strength * (1 + (radius - d2) * 0.5));
      }
    }

    // Remove any entities in the blast radius
    for (let ei = this.entities.length - 1; ei >= 0; ei--) {
      const e = this.entities[ei];
      if (Math.abs(e.x - x) + Math.abs(e.y - y) <= radius) this.entities.splice(ei, 1);
    }
  }

  applyChemistry(dt) {
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      const id = this.mat[i];
      const m = this.getMat(id);

      // Heat sources/sinks (per tick)
      if (m.heatSource && id !== 0) {
        this.temp[i] += m.heatSource * 60 * dt; // scaled to approx per-second feel
      }

      // Gentle ambient pull for air/empty
      if (id === 0) {
        this.temp[i] = lerp(this.temp[i], this.ambientT, 0.02);
      }

      // Decay (per second chance)
      if (id !== 0 && m.decayChance && m.decayChance > 0) {
        const p = 1 - Math.pow(1 - clamp(m.decayChance, 0, 1), dt);
        if (Math.random() < p) this.mat[i] = m.decayInto ?? 0;
      }

      // Phase changes
      const t = this.temp[i];

      // Explosive materials: if they exceed explodeTemp (or a chosen threshold), detonate
      if (m && m.explosive && m.explodeTemp != null && t >= m.explodeTemp) {
        const x = i % this.w, y = Math.floor(i / this.w);
        // optional heat boost immediately before blast
        this.temp[i] += (m.explodeHeatBoost || 0);
        // convert this cell to Fire and blast
        this.triggerExplosion(x, y, { radius: m.explosionRadius ?? 4, strength: m.explosionStrength ?? 10 });
        // clear the detonated material (become Fire)
        this.mat[i] = this.materials.find(mm => mm.name === 'Fire')?.id ?? id;
        continue;
      }

      // Burning: convert burnable materials to Fire when above ignition temp
      if (m && m.burnable && m.ignitionTemp != null && t >= m.ignitionTemp) {
        const x = i % this.w, y = Math.floor(i / this.w);
        const fireId = this.materials.find(mm => mm.name === 'Fire')?.id ?? 15;
        // turn into fire
        this.mat[i] = fireId;
        // raise local temperature and pressure modestly
        this.temp[i] += 40;
        this.press[i] = (this.press[i] || 0) + 2.0;
        continue;
      }

      if (m.state === "solid") {
        if (m.meltTemp != null && t >= m.meltTemp && m.meltInto != null) this.mat[i] = m.meltInto;
      } else if (m.state === "liquid") {
        if (m.freezeTemp != null && t <= m.freezeTemp && m.freezeInto != null) this.mat[i] = m.freezeInto;
        if (m.boilTemp != null && t >= m.boilTemp && m.boilInto != null) this.mat[i] = m.boilInto;
      } else if (m.state === "gas") {
        if (m.condenseTemp != null && t <= m.condenseTemp && m.condenseInto != null) this.mat[i] = m.condenseInto;
      }
    }
  }

  tryMove(iFrom, xFrom, yFrom, xTo, yTo) {
    if (!this.inb(xTo, yTo)) return false;
    const iTo = this.idx(xTo, yTo);

    if (this.updated[iFrom] || this.updated[iTo]) return false;

    const idA = this.mat[iFrom];
    const idB = this.mat[iTo];

    if (idA === idB) return false;

    const mA = this.getMat(idA);
    const mB = this.getMat(idB);

    // Prevent any movement that would displace rigid solids or explicitly immovable materials.
    // Use per-material `immovable` flag instead of treating all `nuclear` as immovable.
    if ((mA && (mA.state === "solid" || mA.immovable)) || (mB && (mB.state === "solid" || mB.immovable))) return false;

    // Empty target
    if (idB === 0) {
      this.mat[iTo] = idA;
      this.mat[iFrom] = 0;

      // Temperature follows particle a bit
      // Move the particle's temperature with it so heat doesn't remain behind
      const tA = this.temp[iFrom];
      this.temp[iTo] = tA;
      // Clear the source cell toward ambient to avoid leaving artificial hot spots
      this.temp[iFrom] = this.ambientT;

      this.updated[iTo] = 1;
      this.updated[iFrom] = 1;
      return true;
    }

    // Swap if density wants it (heavier displaces lighter), also allow gas swapping easily
    const densA = mA.density ?? 1;
    const densB = mB.density ?? 1;

    // Heavier above lighter (sink) OR gas below liquid/solid (bubble up)
    const wantsSwap = (densA > densB && yTo > yFrom) || (mA.state === "gas" && mB.state !== "gas" && yTo < yFrom);

    if (wantsSwap) {
      this.mat[iTo] = idA;
      this.mat[iFrom] = idB;

      // swap temps so heat travels with the material that moved
      const tA = this.temp[iFrom], tB = this.temp[iTo];
      this.temp[iTo] = tA;
      this.temp[iFrom] = tB;

      this.updated[iTo] = 1;
      this.updated[iFrom] = 1;
      return true;
    }

    return false;
  }

  updateSolidsAndLiquids(dt) {
    const g = this.gravity;

    // Iterate bottom-up to reduce "teleporting" down
    const parity = this.tick & 1;

    for (let y = this.h - 2; y >= 0; y--) {
      // alternate x direction each row for symmetry
      const leftToRight = ((y + parity) & 1) === 0;
      if (leftToRight) {
        for (let x = 0; x < this.w; x++) this.updateSLCell(x, y, g);
      } else {
        for (let x = this.w - 1; x >= 0; x--) this.updateSLCell(x, y, g);
      }
    }
  }

  updateSLCell(x, y, g) {
    const i = this.idx(x, y);
    const id = this.mat[i];
    if (id === 0) return;

    const m = this.getMat(id);
    if (m.state === "gas") return;

    // Pressure/wind nudges low-density stuff sideways a bit
    const wind = this.windAt(x, y);
    const windBias = clamp(wind.x * 0.35 / (m.density ?? 1), -1, 1);

    // Rigid solids do not move (unless transformed by chemistry)
    if (m.state === "solid") {
      return;
    }

    // Powders behave like granular solids (fall/diagonal flow)
    if (m.state === "powder") {
      const powder = clamp(m.powder ?? 0.95, 0, 1);
      // gravity chance (more powdery -> more likely to move)
      if (Math.random() > (0.35 + 0.65 * powder) * g) return;

      // Down
      if (this.tryMove(i, x, y, x, y + 1)) return;

      // Diagonal (with slight wind)
      const dir = (Math.random() < 0.5 ? -1 : 1);
      const wdir = windBias > 0.15 ? 1 : (windBias < -0.15 ? -1 : 0);
      const a = dir + wdir;
      const dx1 = a === 0 ? dir : a;

      if (this.tryMove(i, x, y, x + dx1, y + 1)) return;
      if (this.tryMove(i, x, y, x - dx1, y + 1)) return;

      // Small chance to creep sideways if highly granular and pushed by wind/pressure
      if (powder > 0.75 && Math.abs(windBias) > 0.25) {
        const dx = windBias > 0 ? 1 : -1;
        this.tryMove(i, x, y, x + dx, y);
      }
      return;
    }

    if (m.state === "liquid") {
      const visc = clamp(m.viscosity ?? 0.25, 0, 1);

      // Down first, with fewer attempts if viscous
      if (Math.random() > (1 - visc) * 0.95 * g) return;
      if (this.tryMove(i, x, y, x, y + 1)) return;

      // Diagonal down
      const dir = (Math.random() < 0.5 ? -1 : 1);
      const wdir = windBias > 0.10 ? 1 : (windBias < -0.10 ? -1 : 0);
      const dx1 = dir + wdir;
      if (this.tryMove(i, x, y, x + dx1, y + 1)) return;
      if (this.tryMove(i, x, y, x - dx1, y + 1)) return;

      // Sideways flow (less if viscous)
      if (Math.random() < (1 - visc) * 0.85) {
        // Prefer downhill or pressure direction a bit
        const pL = this.press[this.idx(clamp(x - 1, 0, this.w - 1), y)];
        const pR = this.press[this.idx(clamp(x + 1, 0, this.w - 1), y)];
        const pd = pL - pR;
        let dx = dir;
        if (pd > 0.02) dx = -1;
        if (pd < -0.02) dx = 1;
        if (Math.abs(windBias) > 0.2) dx = windBias > 0 ? 1 : -1;

        if (this.tryMove(i, x, y, x + dx, y)) return;
        this.tryMove(i, x, y, x - dx, y);
      }
    }
  }

  updateGases(dt) {
    const parity = this.tick & 1;

    for (let y = 1; y < this.h; y++) {
      const leftToRight = ((y + parity) & 1) === 0;
      if (leftToRight) {
        for (let x = 0; x < this.w; x++) this.updateGasCell(x, y);
      } else {
        for (let x = this.w - 1; x >= 0; x--) this.updateGasCell(x, y);
      }
    }
  }

  updateGasCell(x, y) {
    const i = this.idx(x, y);
    const id = this.mat[i];
    if (id === 0) return;

    const m = this.getMat(id);
    if (m.state !== "gas") return;

    const disp = clamp(m.dispersion ?? 0.9, 0, 1);

    // buoyancy: go up if possible
    if (Math.random() < 0.85 * disp) {
      if (this.tryMove(i, x, y, x, y - 1)) return;
      const dir = Math.random() < 0.5 ? -1 : 1;
      if (this.tryMove(i, x, y, x + dir, y - 1)) return;
      if (this.tryMove(i, x, y, x - dir, y - 1)) return;
    }

    // spread sideways based on dispersion and pressure
    const wind = this.windAt(x, y);
    const windBias = clamp(wind.x * 0.8 / (m.density ?? 0.1), -1, 1);

    if (Math.random() < 0.90 * disp) {
      let dx = Math.random() < 0.5 ? -1 : 1;
      if (windBias > 0.08) dx = 1;
      if (windBias < -0.08) dx = -1;

      // Slightly prefer lower pressure regions
      const pHere = this.press[i];
      const pTo = this.press[this.idx(clamp(x + dx, 0, this.w - 1), y)];
      if (pTo < pHere - 0.01) {
        if (this.tryMove(i, x, y, x + dx, y)) return;
      } else {
        if (this.tryMove(i, x, y, x + dx, y)) return;
        this.tryMove(i, x, y, x - dx, y);
      }
    }

    // minor downward mixing (gas can get trapped)
    if (Math.random() < 0.05) this.tryMove(i, x, y, x, y + 1);
  }

  windAt(x, y) {
    const i = this.idx(x, y);
    const pC = this.press[i];
    const pL = this.press[this.idx(clamp(x - 1, 0, this.w - 1), y)];
    const pR = this.press[this.idx(clamp(x + 1, 0, this.w - 1), y)];
    const pU = this.press[this.idx(x, clamp(y - 1, 0, this.h - 1))];
    const pD = this.press[this.idx(x, clamp(y + 1, 0, this.h - 1))];

    // pressure gradient
    const gx = (pL - pR) * 0.5;
    const gy = (pU - pD) * 0.5;

    return { x: gx, y: gy, p: pC };
  }

  updatePressure(dt) {
    // Build "raw" pressure from gas concentration and local heat (hot air expands)
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      const id = this.mat[i];
      const m = this.getMat(id);
      let p = 0;

      if (id !== 0 && m.state === "gas") {
        // More gas + hotter => higher pressure
        p = 0.55;
        p += clamp((this.temp[i] - this.ambientT) / 400, -0.4, 0.6);
      } else if (id === 0) {
        // Air pressure gently follows temperature too
        p = 0.18 + clamp((this.temp[i] - this.ambientT) / 600, -0.15, 0.25);
      } else {
        // solids/liquids displace air: treat as slightly negative pressure pocket
        p = -0.05;
      }

      this.press2[i] = p;
    }

    // Diffuse/relax pressure
    const diff = 0.18;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        const pC = this.press2[i];
        const pL = this.press2[this.idx(clamp(x - 1, 0, this.w - 1), y)];
        const pR = this.press2[this.idx(clamp(x + 1, 0, this.w - 1), y)];
        const pU = this.press2[this.idx(x, clamp(y - 1, 0, this.h - 1))];
        const pD = this.press2[this.idx(x, clamp(y + 1, 0, this.h - 1))];

        const avg = (pL + pR + pU + pD) * 0.25;
        this.press[i] = lerp(pC, avg, diff);
      }
    }
  }

  updateTemperature(dt) {
    // Diffuse temperature with material conductivity and heat capacity
    const n = this.w * this.h;

    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        const id = this.mat[i];
        const m = this.getMat(id);

        const k = clamp(m.conductivity ?? 0.2, 0, 1);
        const cap = Math.max(0.1, m.heatCapacity ?? 1);

        const tC = this.temp[i];

        // Weighted neighbor average: reduce heat transfer into air to keep heat local
        const neighbors = [ [x-1,y], [x+1,y], [x,y-1], [x,y+1] ];
        let sumT = 0, sumW = 0;
        for (const [nx, ny] of neighbors) {
          const cx = clamp(nx, 0, this.w - 1);
          const cy = clamp(ny, 0, this.h - 1);
          const ii = this.idx(cx, cy);
          const nid = this.mat[ii];
          const nm = this.getMat(nid);
          const nt = this.temp[ii];
          // neighbor conductivity as weight; reduce weight if neighbor is air so hot cells don't instantly dump to air
          let w = clamp(nm.conductivity ?? 0.18, 0, 1);
          if (nid === 0) w *= 0.18; // air is insulating in this sim
          sumT += nt * w;
          sumW += w;
        }
        const avg = sumW > 0 ? (sumT / sumW) : tC;

        // Higher heat capacity slows changes; multiply by material conductivity
        const rate = (0.25 * k) / cap;
        this.temp2[i] = lerp(tC, avg, rate);
      }
    }

    // Swap buffers
    const tmp = this.temp;
    this.temp = this.temp2;
    this.temp2 = tmp;
  }

  // --- Render ---
  render() {
    const img = this.ctx.getImageData(0, 0, this.w, this.h);
    const d = img.data;

    const overlayA = clamp(this.overlayAlpha, 0, 1);

    // precompute rgb for materials for speed
    if (!this._matRGB || this._matRGB.length !== this.materials.length) {
      this._matRGB = this.materials.map(m => hexToRgb(m.color || "#000"));
    }

    // prepare glow buffer when fancy mode enabled
    let glowImg = null, gd = null;
    if (this.displayMode === 'fancy') {
      glowImg = this._glowCtx.createImageData(this.w, this.h);
      gd = glowImg.data;
    }

    for (let i = 0; i < this.w * this.h; i++) {
      const id = this.mat[i];
      const m = this.getMat(id);

      let { r, g, b } = this._matRGB[id] || { r: 0, g: 0, b: 0 };

      // per-cell variation
      const v = clamp(m.colorVar ?? 0, 0, 1);
      if (id !== 0 && v > 0) {
        const randNorm = (this._cellNoise[i] || 0) * 2; // [-1,1]
        const n = randNorm * v; // scale by material var
        r = clamp(r + n * 60, 0, 255);
        g = clamp(g + n * 60, 0, 255);
        b = clamp(b + n * 60, 0, 255);
      }

      // overlays
      if (this.showTemp) {
        const tc = tempColor(this.temp[i]);
        r = lerp(r, tc.r, overlayA);
        g = lerp(g, tc.g, overlayA);
        b = lerp(b, tc.b, overlayA);
      }
      if (this.showPressure) {
        const pc = pressureColor(this.press[i]);
        r = lerp(r, pc.r, overlayA * 0.85);
        g = lerp(g, pc.g, overlayA * 0.85);
        b = lerp(b, pc.b, overlayA * 0.85);
      }

      const o = i * 4;
      d[o + 0] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;

      // Glow contribution based on temperature above ambient (hotter => brighter glow)
      if (gd) {
        const temp = this.temp[i];
        const bright = clamp((temp - this.ambientT) / 400, 0, 1);
        if (bright > 0.01) {
          // Use tempColor tint for glow, scale by brightness squared for emphasis
          const tc = tempColor(temp);
          const gfac = Math.pow(bright, 1.5);
          gd[o + 0] = Math.min(255, Math.round(tc.r * gfac * 1.4));
          gd[o + 1] = Math.min(255, Math.round(tc.g * gfac * 1.2));
          gd[o + 2] = Math.min(255, Math.round(tc.b * gfac * 0.6));
          gd[o + 3] = Math.min(255, Math.round(255 * Math.min(1, gfac * 0.9)));
        } else {
          gd[o + 0] = gd[o + 1] = gd[o + 2] = 0;
          gd[o + 3] = 0;
        }
      }
    }

    this.ctx.putImageData(img, 0, 0);

    // Render entities (neutrons) on top
    if (this.entities && this.entities.length) {
      for (const ent of this.entities) {
        if (!this.inb(ent.x, ent.y)) continue;
        const i = this.idx(ent.x, ent.y);
        const o = i * 4;
        const m = this.getMat(ent.matId) || { color: '#2f8cff' };
        const col = hexToRgb(m.color || '#2f8cff');
        // make them bright and slightly translucent effect by overwriting
        d[o + 0] = Math.min(255, col.r + 60);
        d[o + 1] = Math.min(255, col.g + 60);
        d[o + 2] = Math.min(255, col.b + 60);
        d[o + 3] = 255;
      }
      this.ctx.putImageData(img, 0, 0);
    }

    // If fancy bloom enabled, composite blurred glow on top
    if (this.displayMode === 'fancy' && glowImg) {
      // draw glow image to offscreen and blur via canvas filter
      try {
        this._glowCtx.clearRect(0, 0, this.w, this.h);
        this._glowCtx.putImageData(glowImg, 0, 0);
        // apply blur and composite using lighter blending
        this.ctx.save();
        this.ctx.globalCompositeOperation = 'lighter';
        this.ctx.filter = 'blur(6px)';
        this.ctx.drawImage(this._glowCanvas, 0, 0);
        // additional softer pass
        this.ctx.filter = 'blur(14px)';
        this.ctx.globalAlpha = 0.45;
        this.ctx.drawImage(this._glowCanvas, 0, 0);
        this.ctx.restore();
      } catch (e) {
        // some browsers may not support ctx.filter in all contexts; ignore gracefully
      }
    }
  }
}

// behaviors registry (static on Sandbox)
Sandbox.behaviors = Sandbox.behaviors || {};

// Neutron behavior: moves randomly, can pass through grid (entities are independent), may be absorbed
Sandbox.behaviors.neutron = function(ctx) {
  const sim = ctx.sim;
  const ent = ctx.ent;
  const params = ctx.params || {};

  // movement: random walk with optional gravity/slowdown
  const speed = Math.max(1, params.speed || 1);
  const hx = Math.random();
  let dx = 0;
  if (hx < 0.45) dx = -1;
  else if (hx > 0.55) dx = 1;
  let dy = 0;
  const r = Math.random();
  if (params.affectedByGravity) {
    if (r < 0.12) dy = -1;
    else if (r < 0.72) dy = 1;
    else dy = 0;
  } else {
    if (r < 0.35) dy = -1;
    else if (r < 0.70) dy = 1;
    else dy = 0;
  }

  const nx = clamp(ent.x + dx * speed, 0, sim.w - 1);
  const ny = clamp(ent.y + dy * speed, 0, sim.h - 1);
  ent.x = nx; ent.y = ny;

  // check cell interactions
  const idx = sim.idx(ent.x, ent.y);
  const matId = sim.mat[idx];
  if (matId === 0) return; // through air

  const targetMat = sim.getMat(matId);
  // default small heat on touch
  sim.temp[idx] += 1.0;

  // Reflector: bounce neutrons
  if (targetMat && targetMat.neutronReflector) {
    if (Math.random() < (targetMat.reflectProb || 0.5)) {
      // reverse and damp velocity by random factor
      ent.x = clamp(ent.x - dx, 0, sim.w-1);
      ent.y = clamp(ent.y - dy, 0, sim.h-1);
      return;
    }
  }

  // Absorber: strong chance of capture and conversion to heat
  if (targetMat && targetMat.neutronAbsorber) {
    const baseAbs = 0.05;
    const mult = targetMat.absorbMultiplier || 6;
    if (Math.random() < Math.min(0.99, baseAbs * mult)) {
      sim.temp[idx] += 6;
      // remove neutron
      const ei = ctx.ei; if (ei != null && sim.entities[ei] === ent) sim.entities.splice(ei,1);
      return;
    } else {
      // slow it down
      return;
    }
  }

  // Moderator slows and warms slightly
  if (targetMat && targetMat.moderator) {
    sim.temp[idx] += (targetMat.moderatorHeat || 0.5);
    // small chance to capture
    if (Math.random() < 0.02) { const ei = ctx.ei; if (ei != null && sim.entities[ei] === ent) sim.entities.splice(ei,1); return; }
  }

  // Deuterium handling: mostly heat, sometimes split into neutrons
  if (targetMat && targetMat.deuterium) {
    if (Math.random() < 0.7) {
      sim.temp[idx] += 10;
    } else {
      const nid = sim.materialsByName && sim.materialsByName['Neutron'] ? sim.materialsByName['Neutron'].id : 9;
      for (let k=0;k<2;k++) {
        const rx = clamp(ent.x + (Math.floor(Math.random()*3)-1), 0, sim.w-1);
        const ry = clamp(ent.y + (Math.floor(Math.random()*3)-1), 0, sim.h-1);
        sim.entities.push({ x: rx, y: ry, matId: nid, age: 0, life: 300 });
      }
      sim.temp[idx] += 4.0;
      sim.mat[idx] = 0; // consume
      sim.press[idx] = (sim.press[idx] || 0) + 0.5;
    }
    const ei = ctx.ei; if (ei != null && sim.entities[ei] === ent) sim.entities.splice(ei,1);
    return;
  }

  // Fissile materials: chance to fission and spawn neutrons
  if (targetMat && targetMat.nuclear && targetMat.fissionOnNeutron) {
    let base = targetMat.fissionChance || 0.015;
    if (params.moderated) base *= 1.4;
    if (Math.random() < base) {
      // replace with molten if available
      if (targetMat.moltenId != null) sim.mat[idx] = targetMat.moltenId;
      // spawn neutrons
      const nid = sim.materialsByName && sim.materialsByName['Neutron'] ? sim.materialsByName['Neutron'].id : 9;
      const minY = targetMat.fissionYieldMin || 1;
      const maxY = targetMat.fissionYieldMax || (minY+2);
      const nspawn = minY + Math.floor(Math.random()*(maxY-minY+1));
      for (let k=0;k<nspawn;k++) {
        sim.entities.push({ x: ent.x + (Math.random()-0.5), y: ent.y + (Math.random()-0.5), matId: nid, age: 0, life: 300 });
      }
      sim.temp[idx] += 40;
      sim.press[idx] = (sim.press[idx] || 0) + 4.0;
      // nudge neighbors
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const xx = clamp(ent.x+ox,0,sim.w-1), yy = clamp(ent.y+oy,0,sim.h-1);
        const ii = sim.idx(xx,yy); if (ii === idx) continue;
        sim.temp[ii] += 8 * (1 - (Math.abs(ox)+Math.abs(oy))/4);
        sim.press[ii] = (sim.press[ii] || 0) + 1.0;
      }
      const ei = ctx.ei; if (ei != null && sim.entities[ei] === ent) sim.entities.splice(ei,1);
      return;
    }
  }

  // Explosive materials trigger via applyChemistry, but still remove neutron
  if (targetMat && targetMat.explosive) {
    sim.temp[idx] += (targetMat.explodeHeatBoost ?? 40);
    if (sim.temp[idx] >= (targetMat.explodeTemp || 280)) sim.triggerExplosion(ent.x, ent.y, { radius: targetMat.explosionRadius ?? 5, strength: targetMat.explosionStrength ?? 12 });
  }

  // default: remove neutron after touching non-air unless reflected/slowed above
  const ei = ctx.ei; if (ei != null && sim.entities[ei] === ent) sim.entities.splice(ei,1);
};

// Emitter behavior: when spawned (entity), finds the first non-air material adjacent
// and then places that material in a ring around itself every tick.
Sandbox.behaviors.emitter = function(ctx) {
  const sim = ctx.sim;
  const ent = ctx.ent;
  // store selected target material id on the entity instance
  if (ent._targetMat == null) {
    // scan 8 neighbors for first non-air material
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = clamp(ent.x + ox, 0, sim.w - 1);
        const ny = clamp(ent.y + oy, 0, sim.h - 1);
        const midx = sim.idx(nx, ny);
        const mid = sim.mat[midx];
        if (mid !== 0) { ent._targetMat = mid; break; }
      }
      if (ent._targetMat != null) break;
    }
  }

  // If no target yet, do nothing
  if (ent._targetMat == null) return;

  // place target material in a ring (8 neighbors). Only place into air cells.
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const nx = ent.x + ox;
      const ny = ent.y + oy;
      if (!sim.inb(nx, ny)) continue;
      const ii = sim.idx(nx, ny);
      if (sim.mat[ii] === 0) {
        sim.mat[ii] = ent._targetMat;
        // set temperature to the material's default or a small nudge
        const m = sim.getMat(ent._targetMat);
        sim.temp[ii] = (m && m.defaultTemp != null) ? m.defaultTemp : sim.ambientT + 10;
        sim.updated[ii] = 1;
      }
    }
  }
};

function buildUI(sim) {
  const $ = (id) => document.getElementById(id);

  const matSelect = $("matSelect");
  const categoryList = $("categoryBox");
  const materialsGrid = $("materialsBar");
  const brushSize = $("brushSize");
  const brushSizeVal = $("brushSizeVal");
  const pauseBtn = $("pauseBtn");
  const stepBtn = $("stepBtn");
  const clearBtn = $("clearBtn");
  const speed = $("speed");
  const speedVal = $("speedVal");
  const gravity = $("gravity");
  const gravityVal = $("gravityVal");
  const ambientT = $("ambientT");
  const showTemp = $("showTemp");
  const showPressure = $("showPressure");
  const displayMode = $("displayMode");
  const overlay = $("overlay");
  const overlayVal = $("overlayVal");
  const status = $("status");
  const legend = $("legend");

  const matEditor = $("matEditor");
  const exportBtn = $("exportBtn");
  const resetBtn = $("resetBtn");
  const exportBox = $("exportBox");

  function refreshMatSelect() {
    matSelect.innerHTML = "";
    for (const m of sim.materials) {
      const opt = document.createElement("option");
      opt.value = String(m.id);
      opt.textContent = `${m.id}: ${m.name} (${m.state})`;
      matSelect.appendChild(opt);
    }
    matSelect.value = "1";
  }

  // Build category buttons and material grid
  const CATEGORY_COLORS = {
    solid: "#7b8592",
    powder: "#c7b07a",
    nuclear: "#b23fff",
    liquid: "#3a78ff",
    gas: "#a7adb6",
    default: "#777"
  };

  let currentCategory = null;

  function refreshCategories() {
    // derive categories from material `category` property or fallback to `state`
    const categories = Array.from(new Set(sim.materials.map(m => m.category || m.state)));
    categoryList.innerHTML = "";
    for (const c of categories) {
      const btn = document.createElement("button");
      btn.className = "category-btn";
      btn.textContent = String(c).toUpperCase();
      const col = CATEGORY_COLORS[c] || CATEGORY_COLORS.default;
      btn.style.color = col;
      btn.style.borderColor = col;
      btn.dataset.cat = c;
      btn.addEventListener("click", () => {
        selectCategory(c);
      });
      categoryList.appendChild(btn);
    }
    // auto-select first
    if (!currentCategory && categories.length) currentCategory = categories[0];
    selectCategory(currentCategory);
  }

  function selectCategory(state) {
    currentCategory = state;
    for (const b of categoryList.children) b.classList.toggle("selected", b.dataset.cat === state);
    refreshMaterialsGrid(state);
  }

  function refreshMaterialsGrid(state) {
    materialsGrid.innerHTML = "";
    const mats = sim.materials.filter(m => (m.category || m.state) === state);
    for (const m of mats) {
      const p = document.createElement("button");
      p.className = "material-pill";
      p.textContent = (m.short || m.name).toUpperCase().slice(0,4);
      p.title = `${m.id}: ${m.name}`;
      p.dataset.id = String(m.id);
      // color the pill using the material color and pick contrasting text color
      try {
        if (m.color) {
          p.style.backgroundColor = m.color;
          const rgb = hexToRgb(m.color || '#000');
          const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b);
          p.style.color = lum > 160 ? '#000' : '#fff';
        }
      } catch (e) {}
      p.addEventListener("click", () => {
        matSelect.value = String(m.id);
        // trigger UI updates
        sim._matRGB = null;
        buildEditor(Number(matSelect.value));
        // highlight
        for (const c of materialsGrid.children) c.classList.toggle("sel", c === p);
      });
      materialsGrid.appendChild(p);
    }
    // mark selected material
    for (const c of materialsGrid.children) c.classList.toggle("sel", c.dataset.id === matSelect.value);
  }

  function makeField(label, key, type, extra = {}) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    if (extra.wide) wrap.classList.add("wide");
    const lab = document.createElement("label");
    lab.textContent = label;
    const input = document.createElement(type === "select" ? "select" : "input");
    if (type === "number") {
      input.type = "number";
      input.step = extra.step ?? "0.01";
    } else if (type === "text") {
      input.type = "text";
    } else if (type === "color") {
      input.type = "text";
      input.placeholder = "#rrggbb";
    } else if (type === "select") {
      // options provided later
    }

    input.dataset.key = key;
    wrap.appendChild(lab);
    wrap.appendChild(input);
    return { wrap, input };
  }

  function buildEditor(matId) {
    const m = sim.getMat(matId);
    matEditor.innerHTML = "";

    const fields = [];

    fields.push(makeField("name", "name", "text", { wide: true }));
    fields.push(makeField("state", "state", "select"));
    fields.push(makeField("color", "color", "color"));
    fields.push(makeField("colorVar", "colorVar", "number"));
    fields.push(makeField("density", "density", "number"));
    fields.push(makeField("powder", "powder", "number"));
    fields.push(makeField("viscosity", "viscosity", "number"));
    fields.push(makeField("dispersion", "dispersion", "number"));
    fields.push(makeField("conductivity", "conductivity", "number"));
    fields.push(makeField("heatCapacity", "heatCapacity", "number"));
    fields.push(makeField("heatSource", "heatSource", "number"));
    fields.push(makeField("decayChance", "decayChance", "number"));
    fields.push(makeField("decayInto", "decayInto", "number"));
    fields.push(makeField("meltTemp", "meltTemp", "number"));
    fields.push(makeField("meltInto", "meltInto", "number"));
    fields.push(makeField("freezeTemp", "freezeTemp", "number"));
    fields.push(makeField("freezeInto", "freezeInto", "number"));
    fields.push(makeField("boilTemp", "boilTemp", "number"));
    fields.push(makeField("boilInto", "boilInto", "number"));
    fields.push(makeField("condenseTemp", "condenseTemp", "number"));
    fields.push(makeField("condenseInto", "condenseInto", "number"));

    // Explosive / burning / misc flags
    fields.push(makeField("burnable", "burnable", "number"));
    fields.push(makeField("ignitionTemp", "ignitionTemp", "number"));
    fields.push(makeField("explosive", "explosive", "number"));
    fields.push(makeField("explodeTemp", "explodeTemp", "number"));
    fields.push(makeField("explosionRadius", "explosionRadius", "number"));
    fields.push(makeField("explosionStrength", "explosionStrength", "number"));
    fields.push(makeField("explodeHeatBoost", "explodeHeatBoost", "number"));
    fields.push(makeField("immovable", "immovable", "number"));
    fields.push(makeField("defaultTemp", "defaultTemp", "number"));
    fields.push(makeField("category", "category", "text"));
    fields.push(makeField("short", "short", "text"));

    for (const f of fields) {
      const input = f.input;
      if (input.tagName === "SELECT") {
        if (input.dataset.key === "state") {
          for (const s of ["solid", "powder", "liquid", "gas"]) {
            const o = document.createElement("option");
            o.value = s; o.textContent = s;
            input.appendChild(o);
          }
        }
      }
      matEditor.appendChild(f.wrap);
    }

    // Fill values
    for (const el of matEditor.querySelectorAll("input,select")) {
      const k = el.dataset.key;
      const v = m[k];
      if (v === null || v === undefined) el.value = "";
      else el.value = String(v);
    }

    // Bind
    const onChange = () => {
      // Update material object (except id 0 is allowed too)
      for (const el of matEditor.querySelectorAll("input,select")) {
        const k = el.dataset.key;
        let v = el.value;
        if (v === "") {
          m[k] = (k.endsWith("Temp") ? null : (k.endsWith("Into") ? 0 : null));
          continue;
        }
        if (["name", "state", "color"].includes(k)) {
          m[k] = v;
        } else {
          // allow boolean-like flags as 0/1 numbers
          m[k] = Number(v);
        }
      }
      // Rebuild lookup
      sim.materialsById = new Map(sim.materials.map(mm => [mm.id, mm]));
      sim.materialsByName = Object.fromEntries(sim.materials.map(mm => [mm.name, mm]));
      sim._matRGB = null;
      refreshMatSelect(); // names may have changed
      matSelect.value = String(m.id);
      // update category/material grids (short names may have changed)
      if (typeof refreshCategories === 'function') refreshCategories();
    };

    matEditor.addEventListener("input", onChange);
    matEditor.addEventListener("change", onChange);
  }

  function updateLabels() {
    brushSizeVal.textContent = brushSize.value;
    speedVal.textContent = speed.value + "x";
    gravityVal.textContent = (Number(gravity.value) / 100).toFixed(2);
    overlayVal.textContent = overlay.value + "%";
  }

  refreshMatSelect();
  buildEditor(1);
  refreshCategories();
  updateLabels();

  // Settings button: collapse/expand left panel via `panel-hidden` on #app
  const openSettingsBtn = $("openSettingsBtn");
  const appDiv = $("app");
  if (openSettingsBtn && appDiv) {
    // start with settings closed by default
    appDiv.classList.add("panel-hidden");
    openSettingsBtn.textContent = appDiv.classList.contains("panel-hidden") ? "SETTINGS" : "CLOSE";
    openSettingsBtn.addEventListener("click", () => {
      const hidden = appDiv.classList.toggle("panel-hidden");
      openSettingsBtn.textContent = hidden ? "SETTINGS" : "CLOSE";
    });
  }

  matSelect.addEventListener("change", () => buildEditor(Number(matSelect.value)));
  brushSize.addEventListener("input", updateLabels);
  speed.addEventListener("input", updateLabels);
  gravity.addEventListener("input", () => {
    sim.gravity = Number(gravity.value) / 100;
    updateLabels();
  });
  overlay.addEventListener("input", () => {
    sim.overlayAlpha = Number(overlay.value) / 100;
    updateLabels();
  });
  ambientT.addEventListener("change", () => {
    const v = Number(ambientT.value);
    if (Number.isFinite(v)) sim.setAmbientT(v);
  });

  showTemp.addEventListener("change", () => sim.showTemp = showTemp.checked);
  showPressure.addEventListener("change", () => sim.showPressure = showPressure.checked);
  if (displayMode) {
    displayMode.addEventListener('change', () => sim.displayMode = displayMode.value || 'regular');
    displayMode.value = sim.displayMode;
  }

  pauseBtn.addEventListener("click", () => {
    sim.paused = !sim.paused;
    pauseBtn.textContent = sim.paused ? "Resume" : "Pause";
  });
  stepBtn.addEventListener("click", () => {
    if (!sim.paused) return;
    sim.step(1/60);
    sim.render();
  });
  clearBtn.addEventListener("click", () => sim.clear());

  exportBtn.addEventListener("click", () => {
    exportBox.value = JSON.stringify(sim.materials, null, 2);
    exportBox.focus();
    exportBox.select();
  });
  resetBtn.addEventListener("click", () => {
    sim.materials = structuredClone(DEFAULT_MATERIALS);
    sim.materialsById = new Map(sim.materials.map(m => [m.id, m]));
    sim.materialsByName = Object.fromEntries(sim.materials.map(m => [m.name, m]));
    sim._matRGB = null;
    refreshMatSelect();
    buildEditor(1);
    refreshCategories();
    exportBox.value = "";
  });

  // Status text
  let lastFPS = 0;
  let frameCount = 0;
  let acc = 0;
  let lastT = performance.now();

  function uiTick(now) {
    const dt = (now - lastT) / 1000;
    lastT = now;
    acc += dt;
    frameCount++;
    if (acc >= 0.5) {
      lastFPS = Math.round(frameCount / acc);
      frameCount = 0;
      acc = 0;
    }

    const sel = sim.getMat(Number(matSelect.value));
    status.textContent =
      `FPS: ${lastFPS}   Cells: ${sim.w}x${sim.h}   Speed: ${speed.value}x\n` +
      `Selected: ${sel.id} ${sel.name} (${sel.state})   Brush: ${brushSize.value}`;
    // show hovered material under cursor if available
    if (sim.cursor) {
      const ci = sim.idx(sim.cursor.x, sim.cursor.y);
      const underId = sim.mat[ci];
      const underMat = sim.getMat(underId);
      status.textContent += `   | Under: ${underId} ${underMat.name} (${underMat.state})`;
    }

    legend.textContent =
      `Temp: shift=heat, alt=cool. Overlays show relative fields.\n` +
      `Tip: paint lava under water for steam + convection-like motion.`;

    requestAnimationFrame(uiTick);
  }
  requestAnimationFrame(uiTick);

  // Keybindings: 1=regular, 2=fancy, 3=temperature view, 4=pressure view
  window.addEventListener('keydown', (ev) => {
    // ignore when typing in inputs/textareas
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

    // display mode keys
    if (ev.key === '1') {
      sim.displayMode = 'regular';
      if (displayMode) displayMode.value = 'regular';
      sim.showTemp = false; sim.showPressure = false; if (showTemp) showTemp.checked = false; if (showPressure) showPressure.checked = false;
      return;
    }
    if (ev.key === '2') {
      sim.displayMode = 'fancy';
      if (displayMode) displayMode.value = 'fancy';
      sim.showTemp = false; sim.showPressure = false; if (showTemp) showTemp.checked = false; if (showPressure) showPressure.checked = false;
      return;
    }
    if (ev.key === '3') {
      sim.displayMode = 'regular';
      if (displayMode) displayMode.value = 'regular';
      sim.showTemp = true; sim.showPressure = false; if (showTemp) showTemp.checked = true; if (showPressure) showPressure.checked = false;
      return;
    }
    if (ev.key === '4') {
      sim.displayMode = 'regular';
      if (displayMode) displayMode.value = 'regular';
      sim.showTemp = false; sim.showPressure = true; if (showTemp) showTemp.checked = false; if (showPressure) showPressure.checked = true;
      return;
    }

    // Category/material navigation
    if (ev.key === 'ArrowUp') {
      // cycle to next category
      const cats = Array.from(categoryList.children);
      if (!cats.length) return;
      const curIdx = cats.findIndex(b => b.classList.contains('selected'));
      const next = cats[(curIdx + 1 + cats.length) % cats.length];
      if (next) next.click();
      ev.preventDefault();
      return;
    }

    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      // move selection among materials in current category
      const pills = Array.from(materialsGrid.children);
      if (!pills.length) return;
      const cur = pills.findIndex(p => p.classList.contains('sel'));
      let idx = cur;
      if (idx === -1) idx = 0; // fallback
      if (ev.key === 'ArrowLeft') idx = (idx - 1 + pills.length) % pills.length;
      else idx = (idx + 1) % pills.length;
      const target = pills[idx];
      if (target) target.click();
      ev.preventDefault();
      return;
    }
  });

  return {
    get brushRadius() { return Number(brushSize.value); },
    get selectedMat() { return Number(matSelect.value); },
    get speedMult() { return Number(speed.value); }
  };
}

function attachInput(sim, ui) {
  const canvas = sim.canvas;

  let down = false;
  let button = 0;
  let lastPos = null;

  const getCell = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - rect.left) / rect.width * sim.w);
    const y = Math.floor((ev.clientY - rect.top) / rect.height * sim.h);
    return { x: clamp(x, 0, sim.w - 1), y: clamp(y, 0, sim.h - 1) };
  };

  const paintAt = (ev) => {
    const { x, y } = getCell(ev);
    const r = ui.brushRadius;
    const matId = ui.selectedMat;

    const heat = ev.shiftKey;
    const cool = ev.altKey;

    if (heat) sim.paintCircle(x, y, r, matId, "heat", 1);
    else if (cool) sim.paintCircle(x, y, r, matId, "cool", 1);
    else if (button === 2) sim.paintCircle(x, y, r, matId, "erase", 1);
    else sim.paintCircle(x, y, r, matId, "paint", 1);
  };

  // track hovered cell for debug/status
  canvas.addEventListener("mousemove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - rect.left) / rect.width * sim.w);
    const y = Math.floor((ev.clientY - rect.top) / rect.height * sim.h);
    sim.cursor = { x: clamp(x, 0, sim.w - 1), y: clamp(y, 0, sim.h - 1) };
  });

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // Wheel to change brush size
  canvas.addEventListener('wheel', (ev) => {
    // ignore when typing in inputs/textareas
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    ev.preventDefault();
    const bs = document.getElementById('brushSize');
    if (!bs) return;
    const delta = Math.sign(ev.deltaY) * -1; // wheel up -> increase
    let val = Number(bs.value) || 1;
    val = clamp(val + delta, Number(bs.min) || 1, Number(bs.max) || 12);
    bs.value = String(val);
    // update labels if the UI helper exists
    const evInput = new Event('input', { bubbles: true });
    bs.dispatchEvent(evInput);
  }, { passive: false });

  canvas.addEventListener("mousedown", (ev) => {
    down = true;
    button = ev.button;
    paintAt(ev);
  });

  window.addEventListener("mouseup", () => down = false);

  window.addEventListener("mousemove", (ev) => {
    if (!down) return;
    paintAt(ev);
  });
}

function main() {
  const canvas = document.getElementById("c");

  // Grid resolution (tune for your machine)
  const sim = new Sandbox(canvas, { w: 240, h: 160, cellSize: 1 });

  const ui = buildUI(sim);
  attachInput(sim, ui);

  let last = performance.now();
  const fixed = 1 / 60;

  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;

    const steps = ui.speedMult;
    if (!sim.paused) {
      // Use fixed steps for stability
      for (let s = 0; s < steps; s++) sim.step(fixed);
    }
    sim.render();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main();
