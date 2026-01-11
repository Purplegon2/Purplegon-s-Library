import { DEFAULT_MATERIALS } from "./materials.js";
import { DEFAULT_RECIPES } from "./recipe.js";

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
    this.pressInject = new Float32Array(n); // transient pressure injections (from movement/explosions)
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
    this.displayMode = 'fancy';

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
    // convert any grid-placed entity-type materials (legacy) into entities
    this.extractGridEntities();

    // color seed / deterministic per-cell noise to keep pixel colors constant
    this.colorSeed = Number(opts.seed ?? 123456789) >>> 0;
    this._cellNoise = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const rng = mulberry32((this.colorSeed + i) >>> 0);
      this._cellNoise[i] = rng() - 0.5; // store in [-0.5,0.5]
    }

    // Compile per-material scripts (if any) into runtime functions cached on material objects
    this.compileMaterialScripts();
    // Recipes: build table from defaults and enable/disable controls
    try {
      this.recipes = this.buildRecipesTable(DEFAULT_RECIPES, this.materialsByName);
    } catch (e) {
      this.recipes = [];
    }
    this.enableRecipes = true;
    this.recipeTickStep = 4; // run recipe evaluation every N ticks (tunable)
    // Edge behavior at simulation bounds: 'walled' (default) or 'void' (particles disappear)
    this.edgeMode = 'walled';
    // Blast pressure multiplier (percentage slider maps to value/100)
    this.blastPressure = 0.0;
    // Global pressure scale applied to all pressure adds/subtracts
    this.pressureScale = 0.0;
    // Safety cap for electrons to avoid runaway entity explosion
    this.maxElectrons = 1500;
    // deferred placements used to animate move-tool commit settling
    this._deferredPlacements = [];
  }

  // Compile any 'script' strings on materials into callable functions saved on the material object.
  compileMaterialScripts() {
    if (!this.materials || !Array.isArray(this.materials)) return;
    for (const m of this.materials) {
      // Clear any previous compiled handle
      delete m.compiledScript;
      if (!m || !m.script || typeof m.script !== 'string') continue;
      try {
        // Create a safe wrapper function that will be invoked with `this` bound to a cell object.
        // Parameters available to the script: game, canvas, helpers, params, tick
        const src = 'try{ return (function(){\n' + m.script + '\n}).call(this); } catch(e) { throw e; }';
        m.compiledScript = new Function('game', 'canvas', 'helpers', 'params', 'tick', src);
        // default throttling if unset
        if (m.scriptInterval == null) m.scriptInterval = 16;
        if (m.sampleRate == null) m.sampleRate = 1.0; // 1.0 = always when interval matches
        m._scriptEnabled = true;
        m._scriptRunCount = 0;
        console.info(`Compiled script for material: ${m.name}`);
      } catch (e) {
        console.error(`Failed to compile script for material ${m.name}:`, e);
        m._scriptEnabled = false;
      }
    }
  }

  // Convert any cells holding an entity-type material into actual entities and clear the cell.
  extractGridEntities() {
    if (!this.materials) return;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        const id = this.mat[i];
        if (id === 0) continue;
        const m = this.getMat(id);
        if (m && m.entity) {
          // spawn entity at cell
          const ent = { x, y, matId: m.id, age: 0 };
          if (m.behaviorParams && Number(m.behaviorParams.lifetime) > 0) ent.life = Number(m.behaviorParams.lifetime);
          // give some random velocity for neutrons
          if (m.behavior === 'neutron') { ent.vx = (Math.random()-0.5)*2; ent.vy = (Math.random()-0.5)*2; }
          this.entities.push(ent);
          // clear cell
          this.mat[i] = 0;
          this.temp[i] = this.ambientT;
        }
      }
    }
  }

  resetTemps() {
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) { this.temp[i] = this.ambientT; this.temp2[i] = this.ambientT; }
  }

  idx(x, y) { return x + y * this.w; }
  inb(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }

  // Pressure helpers: all pressure increments go through these so they can be globally scaled.
  addPressure(i, a) {
    const amount = a * 20;
    if (!Number.isFinite(amount) || amount === 0) return;
    const scale = (this.pressureScale != null) ? this.pressureScale : 1.0;
    this.pressInject[i] = (this.pressInject[i] || 0) + amount * scale;
  }

  // Add pressure but ensure it doesn't drop below previous value (used for blast maxing behavior)
  addPressureMax(i, amount) {
    if (!Number.isFinite(amount) || amount === 0) return;
    const scale = (this.pressureScale != null) ? this.pressureScale : 1.0;
    const cur = this.pressInject[i] || 0;
    this.pressInject[i] = Math.max(cur, cur + amount * scale);
  }

  getMat(id) { return this.materialsById.get(id) || this.materialsById.get(0); }

  // Apply a named tool effect centered at (cx,cy) with integer radius and intensity
  applyTool(toolType, cx, cy, radius = 2, intensity = 1.0, opts = {}) {
    let r = Math.max(0, Math.floor((radius != null) ? radius : (this._ui ? this._ui.brushRadius : 2)));
    // For the move tool, always prefer the live UI brush radius so user resizing takes effect.
    if (toolType === 'move' && this._ui) {
      try {
        const br = Number(this._ui.brushRadius) || r;
        r = Math.max(0, Math.floor(br));
      } catch (e) { /* ignore */ }
    }
    // Special-case move tool: handle capture/place once per invocation
    if (toolType === 'move') {
      if (!this._moveActive) {
        this._moveBuffer = [];
        this._moveRadius = r;
        this._moveOrigin = { x: cx, y: cy };
        for (let ry = -r; ry <= r; ry++) {
          for (let rx = -r; rx <= r; rx++) {
            if ((rx*rx + ry*ry) > (r*r)) continue;
            const sx = cx + rx, sy = cy + ry;
            if (!this.inb(sx, sy)) continue;
            const si = this.idx(sx, sy);
            this._moveBuffer.push({ dx: rx, dy: ry, mat: this.mat[si], temp: this.temp[si] });
            // remove from world (lift)
            this.mat[si] = 0;
            this.temp[si] = this.ambientT;
            this.updated[si] = 1;
          }
        }
        this._moveActive = true;
        this._movePlacedAt = null;
      } else {
        // update ghost placement only (do not write into the simulation yet)
        this._movePlacedAt = { x: cx, y: cy };
      }
      return;
    }
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx, y = cy + dy;
        if (!this.inb(x, y)) continue;
        // use circular mask
        if ((dx * dx + dy * dy) > (r * r)) continue;
        const ii = this.idx(x, y);
        if (toolType === 'pressure_up') {
          this.addPressure(ii, intensity);
        } else if (toolType === 'pressure_down') {
          this.addPressure(ii, -Math.abs(intensity));
        } else if (toolType === 'heat') {
          this.temp[ii] = (this.temp[ii] || this.ambientT) + intensity;
          this.temp2[ii] = this.temp[ii];
          this.updated[ii] = 1;
        } else if (toolType === 'cool') {
          this.temp[ii] = (this.temp[ii] || this.ambientT) - intensity;
          this.temp2[ii] = this.temp[ii];
          this.updated[ii] = 1;
        } else if (toolType === 'mixer') {
          // Mixer: encourage mixing of neighboring cells with similar density
          const idA = this.mat[ii];
          if (idA === 0) continue;
          const mA = this.getMat(idA);
          // examine 4-neighbors and perform probabilistic blending if densities match
          const neigh = [[1,0],[-1,0],[0,1],[0,-1]];
          for (const d of neigh) {
            const nx = x + d[0], ny = y + d[1];
            if (!this.inb(nx, ny)) continue;
            const jj = this.idx(nx, ny);
            const idB = this.mat[jj];
            if (idB === 0 || idB === idA) continue;
            const mB = this.getMat(idB);
            // densities were scaled in buildMaterialsTable; compare relative similarity
            const densA = mA?.density ?? 0;
            const densB = mB?.density ?? 0;
            const tol = Math.max(0.01, Math.abs(densA) * 0.15);
            if (Math.abs(densA - densB) <= tol) {
              // with some chance, swap one into the other to intermix
              if (Math.random() < 0.35 * Math.min(1, intensity)) {
                // randomly pick which direction to copy
                if (Math.random() < 0.5) {
                  this.mat[jj] = idA; this.updated[jj] = 1;
                } else {
                  this.mat[ii] = idB; this.updated[ii] = 1;
                }
              }
            }
          }
        }
        
      }
    }
  }

  // Finalize any active move (drop or cancel)
  finishMove(commit = true) {
    if (!this._moveActive) return;
    // If committing and we've placed a ghost, write buffer to placed location.
    if (commit && this._movePlacedAt) {
      const px = this._movePlacedAt.x, py = this._movePlacedAt.y;
      // schedule gradual placements so materials settle naturally
      const baseDelay = 8; // base ticks to wait (tweakable)
      const extraSpread = 6; // vertical staggering
      const r = this._moveRadius || 1;
      for (const c of this._moveBuffer) {
        const tx = px + c.dx, ty = py + c.dy;
        if (!this.inb(tx, ty)) continue;
        const mobj = this.getMat(c.mat) || {};
        const density = Number(mobj.density || 1);
        const viscosity = Number(mobj.viscosity || 0);
        const state = mobj.state || '';
        // density factor: heavier materials settle sooner
        const densityFactor = Math.max(0.25, Math.min(3, density));
        // viscosity slows settling for liquids
        const viscFactor = (state === 'liquid' || state === 'powder') ? (1 + viscosity * 4) : 1;
        let delay = Math.max(0, Math.floor(baseDelay * (1.2 / densityFactor) * viscFactor));
        // vertical bias: lower rows should appear sooner to simulate stacking
        const verticalWeight = (c.dy + r) / (2 * r); // 0..1
        const verticalBonus = Math.floor(verticalWeight * extraSpread);
        const tickDue = Math.max(this.tick, this.tick + delay - verticalBonus);
        this._deferredPlacements.push({ tickDue, x: tx, y: ty, mat: c.mat, temp: c.temp });
      }
    } else {
      // cancel or no placement: restore original origin
      const ox = this._moveOrigin.x, oy = this._moveOrigin.y;
      for (const c of this._moveBuffer) {
        const rx = ox + c.dx, ry = oy + c.dy;
        if (!this.inb(rx, ry)) continue;
        const i = this.idx(rx, ry);
        this.mat[i] = c.mat;
        if (typeof c.temp === 'number') this.temp[i] = c.temp;
        this.updated[i] = 1;
      }
    }
    // clear temp state
    this._moveBuffer = null;
    this._moveActive = false;
    this._movePlacedAt = null;
    this._moveOrigin = null;
    this._moveRadius = null;
  }

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
          this.temp2[i] = this.ambientT;
          for (let ei = this.entities.length - 1; ei >= 0; ei--) {
            const e = this.entities[ei];
            if (Math.floor(e.x) === x && Math.floor(e.y) === y) this.entities.splice(ei, 1);
          }
          this.updated[i] = 1;
        } else if (mode === "paint") {
          const m = this.getMat(matId);
          // If material is an entity (neutron, emitter, etc.), spawn entity only
          if (m && m.entity) {
            const life = (m.behaviorParams && Number(m.behaviorParams.lifetime)) || 0;
            const ent = { x, y, matId: m.id, age: 0 };
            if (life > 0) ent.life = life;
            // give a tiny random velocity for mobile entities (neutrons)
            if (!ent.vx && m.behavior === 'neutron') {
              ent.vx = (Math.random() - 0.5) * 2;
              ent.vy = (Math.random() - 0.5) * 2;
            }
            this.entities.push(ent);
            this.updated[i] = 1;
          } else {
                const prev = this.mat[i];
                // If material is marked as a tool, apply its effect immediately without replacing underlying material
                if (m && m.isTool) {
                  try {
                    this.applyTool(m.toolType || m.name, x, y, m.toolRadius || r, m.toolIntensity || intensity, m);
                  } catch (e) { console.error('applyTool error', e); }
                  // leave underlying material intact; mark updated for redraw
                  this.updated[i] = 1;
                } else {
                  this.mat[i] = matId;
                  if (m && m.defaultTemp != null) { this.temp[i] = m.defaultTemp; this.temp2[i] = m.defaultTemp; }
                  // if painting into air, increase local pressure due to displacement
                  if (prev === 0) {
                    this.addPressure(i, Math.max(0.05, (m?.density ?? 1) * 0.15));
                  }
                  this.updated[i] = 1;
                }
          }
        } else if (mode === "heat") {
          this.temp[i] += 6 * intensity;
          this.temp2[i] = this.temp[i];
        } else if (mode === "cool") {
          this.temp[i] -= 6 * intensity;
          this.temp2[i] = this.temp[i];
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

    // If edgeMode is 'void', clear any materials on the outermost boundary
    // so particles that reach the edge disappear immediately.
    if (this.edgeMode === 'void') {
      // top and bottom rows
      for (let x = 0; x < this.w; x++) {
        const it = this.idx(x, 0);
        const ib = this.idx(x, this.h - 1);
        if (this.mat[it] !== 0) { this.mat[it] = 0; this.temp[it] = this.ambientT; this.press[it] = 0; this.updated[it] = 1; }
        if (this.mat[ib] !== 0) { this.mat[ib] = 0; this.temp[ib] = this.ambientT; this.press[ib] = 0; this.updated[ib] = 1; }
      }
      // left and right columns (skip corners already handled)
      for (let y = 1; y < this.h - 1; y++) {
        const il = this.idx(0, y);
        const ir = this.idx(this.w - 1, y);
        if (this.mat[il] !== 0) { this.mat[il] = 0; this.temp[il] = this.ambientT; this.press[il] = 0; this.updated[il] = 1; }
        if (this.mat[ir] !== 0) { this.mat[ir] = 0; this.temp[ir] = this.ambientT; this.press[ir] = 0; this.updated[ir] = 1; }
      }
      // remove any entities exactly on or outside the edge
      for (let ei = this.entities.length - 1; ei >= 0; ei--) {
        const e = this.entities[ei];
        const ex = Math.floor(e.x), ey = Math.floor(e.y);
        if (ex < 0 || ex > this.w - 1 || ey < 0 || ey > this.h - 1) this.entities.splice(ei, 1);
        else if (ex === 0 || ex === this.w - 1 || ey === 0 || ey === this.h - 1) this.entities.splice(ei, 1);
      }
    }

    // Run any per-material scripts (sparsely throttled)
    if (typeof this.applyMaterialScripts === 'function') this.applyMaterialScripts(dtSeconds);

    // Run recipe evaluation at configured interval (may mutate cells)
    if (this.enableRecipes && Array.isArray(this.recipes) && this.recipes.length > 0) {
      if ((this.tick % Math.max(1, this.recipeTickStep)) === 0) {
        try {
          const matches = this.findRecipeMatches(this, this.recipes);
          if (matches && matches.length > 0) this.applyRecipeMatches(this, matches);
        } catch (e) {
          console.error('Error while evaluating recipes:', e);
        }
      }
    }

    // Update pressure field (derived + diffused)
    this.updatePressure(dtSeconds);

    // Apply pressure effects (breaking solids, etc.)
    if (typeof this.applyPressureEffects === 'function') this.applyPressureEffects(dtSeconds);

    // Update temperature diffusion
    this.updateTemperature(dtSeconds);

    // Process any deferred placements (from move tool) so committed cells appear gradually.
    if (this._deferredPlacements && this._deferredPlacements.length) {
      const nowTick = this.tick;
      const remaining = [];
      for (const p of this._deferredPlacements) {
        if (p.tickDue <= nowTick) {
          if (!this.inb(p.x, p.y)) continue;
          const i = this.idx(p.x, p.y);
          this.mat[i] = p.mat;
          if (typeof p.temp === 'number') this.temp[i] = p.temp;
          this.updated[i] = 1;
        } else {
          remaining.push(p);
        }
      }
      this._deferredPlacements = remaining;
    }
  }

  // Entity behavior system
  applyEntityBehaviors(dt) {
    if (!this.entities || this.entities.length === 0) return;
    // iterate entities by index (allow removal)
    for (let ei = this.entities.length - 1; ei >= 0; ei--) {
      const ent = this.entities[ei];
      // remove entities that are outside the world when in void edge mode
      if (!this.inb(Math.floor(ent.x), Math.floor(ent.y))) {
        if (this.edgeMode === 'void') { this.entities.splice(ei, 1); continue; }
        // otherwise, keep them inside the bounds
        ent.x = clamp(ent.x, 0, this.w - 1);
        ent.y = clamp(ent.y, 0, this.h - 1);
      }
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

    const bp = (opts && opts.blastPressure != null) ? opts.blastPressure : (this.blastPressure || 1.0);
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
        const heatBoost = strength * (1 + (radius - d2) * 0.25);
        this.temp[i] += heatBoost;
        // increase pressure locally (will be diffused later)
        const pressBoost = strength * (1 + (radius - d2) * 0.5) * bp;
        this.addPressureMax(i, pressBoost);
      }
    }

    // Attempt to push nearby cells outward using tryMove to create a stronger blast impulse.
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx, ny = y + dy;
        if (!this.inb(nx, ny)) continue;
        const d2 = Math.abs(dx) + Math.abs(dy);
        if (d2 > radius) continue;
        const i = this.idx(nx, ny);
        const pressBoost = strength * (1 + Math.max(0, radius - d2) * 0.5) * bp;

        // direction away from explosion center
        let dirX = Math.sign(dx);
        let dirY = Math.sign(dy);
        // if directly aligned on an axis, randomize slight lateral push
        if (dirX === 0 && dirY === 0) continue;
        if (dirX === 0) dirX = (Math.random() < 0.5) ? -1 : 1;
        if (dirY === 0) dirY = (Math.random() < 0.5) ? -1 : 1;

        // number of push attempts scales with pressBoost (clamped)
        const attempts = Math.min(3, 1 + Math.floor(pressBoost / 4));
        for (let a = 0; a < attempts; a++) {
          const tx = nx + dirX;
          const ty = ny + dirY;
          if (!this.inb(tx, ty)) break;
          // try to move the cell outward; stop if moved
          if (this.tryMove(i, nx, ny, tx, ty)) break;
          // if couldn't move, try slight variation (rotate direction)
          const swapX = dirY; const swapY = -dirX;
          const tx2 = nx + swapX, ty2 = ny + swapY;
          if (this.inb(tx2, ty2) && this.tryMove(i, nx, ny, tx2, ty2)) break;
        }
      }
    }

    // Impart impulse to nearby entities instead of removing them
    for (let ei = 0; ei < this.entities.length; ei++) {
      const e = this.entities[ei];
      const dx = e.x - x, dy = e.y - y;
      const dist = Math.hypot(dx, dy) + 0.001;
      if (dist > radius + 0.5) continue;
      const d2 = Math.abs(Math.round(dx)) + Math.abs(Math.round(dy));
      const pressBoost = strength * (1 + Math.max(0, radius - d2) * 0.5);
      // impulse scales with pressure/strength and inversely with distance
      const impulse = (pressBoost / Math.max(1, dist)) * 0.6;
      e.vx = (e.vx || 0) + (dx / dist) * impulse * (0.8 + Math.random() * 0.8);
      e.vy = (e.vy || 0) + (dy / dist) * impulse * (0.8 + Math.random() * 0.8);
      // also heat entities' underlying cell slightly
      const ix = clamp(Math.floor(e.x), 0, this.w-1);
      const iy = clamp(Math.floor(e.y), 0, this.h-1);
      this.temp[this.idx(ix, iy)] += Math.min(pressBoost * 0.5, 200);
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
        this.triggerExplosion(x, y, { radius: m.explosionRadius ?? 4, strength: m.explosionStrength ?? 10, blastPressure: (m.blastPressure != null ? m.blastPressure : 1.0) });
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
        this.addPressure(i, 2.0);
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
    if (!this.inb(xTo, yTo)) {
      if (this.edgeMode === 'void') {
        // If edge mode is void, the particle/entity leaving the grid should disappear.
        this.mat[iFrom] = 0;
        this.temp[iFrom] = this.ambientT;
        for (let ei = this.entities.length - 1; ei >= 0; ei--) {
          const e = this.entities[ei];
          if (Math.floor(e.x) === xFrom && Math.floor(e.y) === yFrom) this.entities.splice(ei, 1);
        }
        this.updated[iFrom] = 1;
        return true;
      }
      return false;
    }
    const iTo = this.idx(xTo, yTo);

    // Allow strong pressure differences to override per-tick updated blocking so
    // high-pressure pushes can move material even if parts already acted this tick.
    const pFromEarly = this.press[iFrom] || 0;
    const pToEarly = this.press[iTo] || 0;
    const earlyPressDiff = Math.abs(pFromEarly - pToEarly);
    if ((this.updated[iFrom] || this.updated[iTo]) && earlyPressDiff <= 0.35) return false;

    const idA = this.mat[iFrom];
    const idB = this.mat[iTo];

    if (idA === idB) return false;

    const mA = this.getMat(idA);
    const mB = this.getMat(idB);

    const pFrom = this.press[iFrom] || 0;
    const pTo = this.press[iTo] || 0;

    // Prevent any movement that would displace rigid solids or explicitly immovable materials.
    // Use per-material `immovable` flag instead of treating all `nuclear` as immovable.
    if ((mA && (mA.state === "solid" || mA.immovable)) || (mB && (mB.state === "solid" || mB.immovable))) return false;

    // Empty target
    if (idB === 0) {
      // Simple air-displacement: chance to be slowed for very low-density particles,
      // and generate local pressure proportional to density.
      const densA = mA.density;
      // low-density items (like paper) get some drag when moving through air
      const dragProb = clamp((0.5 - densA) * 0.6, 0, 0.9);
      // If pressure strongly favors movement into the target (vacuum), allow despite drag.
      const pressureFavor = Math.max(0, pFrom - pTo);
      if (pressureFavor > 0.005 && Math.random() < Math.min(1, pressureFavor * 12.0)) {
        // allow move (skip drag)
      } else if (Math.random() < dragProb) {
        // increase local pressure where the particle tried to move
        this.addPressure(iFrom, Math.max(0.1, (densA*20) * 0.25));
        this.updated[iFrom] = 1;
        return false;
      }

      // perform move
      this.mat[iTo] = idA;
      this.mat[iFrom] = 0;

      // Temperature follows particle a bit
      const tA = this.temp[iFrom];
      this.temp[iTo] = tA;
      this.temp[iFrom] = this.ambientT;

      // increase pressure in the displaced air (vacated cell and nearby air neighbors)
      // heavier materials create larger wakes
      const basePush = Math.max(0.05, (densA*20) * 0.18);
      const verticalFactor = (yTo > yFrom) ? 1.6 : 1.0; // falling creates stronger wake
      const totalPush = basePush * verticalFactor;
      // vacated cell is now air — inject a substantial fraction there so the wake originates inside the void
      this.addPressure(iFrom, totalPush * 0.6);
      // also distribute remaining push to adjacent air neighbors around the destination so the wake spreads
      const deltas = [[1,0],[-1,0],[0,1],[0,-1]];
      const airNeighbors = [];
      for (const d of deltas) {
        const nx = xTo + d[0], ny = yTo + d[1];
        if (!this.inb(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (this.mat[ni] === 0) airNeighbors.push(ni);
      }
      if (airNeighbors.length > 0) {
        const share = (totalPush * 0.4) / airNeighbors.length;
        for (const ni of airNeighbors) this.addPressure(ni, share);
      } else {
        // fallback: add a small amount to the source cell if no adjacent air found
        this.addPressure(iFrom, totalPush * 0.15);
      }

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
      // movement pressure: heavier materials displacing lighter ones create wakes
      try {
        const densA = mA.density ?? 1;
        const densB = mB.density ?? 1;
        const diff = Math.max(0, densA - densB);
        const push = Math.max(0.02, diff * 0.12);
        const verticalFactor = (yTo > yFrom) ? 1.4 : 1.0;
        const totalPush = push * verticalFactor;
        // For swaps, inject into any nearby air cells around both positions so the wake exists in air
        const deltas = [[1,0],[-1,0],[0,1],[0,-1]];
        const neighbors = new Set();
        for (const d of deltas) {
          let nx = xTo + d[0], ny = yTo + d[1];
          if (this.inb(nx, ny) && this.mat[this.idx(nx, ny)] === 0) neighbors.add(this.idx(nx, ny));
          nx = xFrom + d[0]; ny = yFrom + d[1];
          if (this.inb(nx, ny) && this.mat[this.idx(nx, ny)] === 0) neighbors.add(this.idx(nx, ny));
        }
        if (neighbors.size > 0) {
          const share = totalPush / neighbors.size;
          for (const ni of neighbors) this.addPressure(ni, share);
        } else {
          // fallback: perturb the source/destination cells
          this.addPressure(iTo, totalPush * 0.6);
          this.addPressure(iFrom, totalPush * 0.4);
        }
      } catch (e) { /* non-fatal */ }
      return true;
    }

    // If pressure favors movement from source to target, attempt a pressure-driven swap/push.
    // This lets liquids/powders flow into lower-pressure pockets even if density rules don't require it.
    const pressDiff = pFrom - pTo;
    const pressPushThreshold = 0.02; // tunable (lower -> more sensitive)
    if (pressDiff > pressPushThreshold && mA && mA.state !== 'solid' && !(mA.immovable)) {
      // avoid pushing rigid/immovable recipients
      if (!(mB && (mB.state === 'solid' || mB.immovable))) {
        // probabilistic to avoid deterministic chaotic swaps
        if (Math.random() < clamp((pressDiff - pressPushThreshold) * 10.0, 0, 0.98)) {
          // perform swap to push material into lower-pressure cell
          this.mat[iTo] = idA;
          this.mat[iFrom] = idB;
          const tA = this.temp[iFrom], tB = this.temp[iTo];
          this.temp[iTo] = tA; this.temp[iFrom] = tB;
          this.updated[iTo] = 1; this.updated[iFrom] = 1;
          // inject some wake pressure into surrounding air to reflect movement
          try {
            const deltas = [[1,0],[-1,0],[0,1],[0,-1]];
            const neighbors = [];
            for (const d of deltas) {
              const nx = xTo + d[0], ny = yTo + d[1]; if (!this.inb(nx, ny)) continue; const ni = this.idx(nx, ny);
              if (this.mat[ni] === 0) neighbors.push(ni);
            }
            const totalPush = Math.min(1.0, pressDiff * 0.6);
            if (neighbors.length > 0) {
              const share = totalPush / neighbors.length;
              for (const ni of neighbors) this.addPressure(ni, share);
            } else {
              this.addPressure(iFrom, totalPush * 0.5);
              this.addPressure(iTo, totalPush * 0.5);
            }
          } catch (e) { /* non-fatal */ }
          return true;
        }
      }
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

    // Pressure/wind nudges low-density stuff sideways a bit (pressure moves lighter materials more)
    const wind = this.windAt(x, y);
    const pressureFactor = 6.0; // tunable multiplier — much stronger pressure influence
    const windBias = clamp(wind.x * (0.9 * pressureFactor) / (m.density ?? 1), -1, 1);

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

      // Diagonal (with stronger wind/pressure influence)
      const dir = (Math.random() < 0.5 ? -1 : 1);
      const wdir = windBias > 0.15 ? 1 : (windBias < -0.15 ? -1 : 0);
      const a = dir + wdir;
      const dx1 = a === 0 ? dir : a;

      if (this.tryMove(i, x, y, x + dx1, y + 1)) return;
      if (this.tryMove(i, x, y, x - dx1, y + 1)) return;

      // Small chance to creep sideways if highly granular and pushed by wind/pressure
      if (powder > 0.5) {
        // probability scaled by absolute windBias; stronger effect
        const prob = Math.min(0.995, Math.abs(windBias) * 1.4);
        if (Math.random() < prob) {
          const dx = windBias > 0 ? 1 : -1;
          this.tryMove(i, x, y, x + dx, y);
        }
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

      // Sideways flow (less if viscous). Use pressure gradient magnitude to bias movement probabilistically.
      if (Math.random() < (1 - visc) * 0.95) {
        const pL = this.press[this.idx(clamp(x - 1, 0, this.w - 1), y)];
        const pR = this.press[this.idx(clamp(x + 1, 0, this.w - 1), y)];
        // positive push means move right (lower pressure to the right)
        const push = clamp((pR - pL) * 20.0 / Math.max(0.1, (m.density ?? 1)), -1, 1);
        let dx = dir;
        // Strong pressure gradients override random direction
        if (Math.abs(push) > 0.08) dx = push > 0 ? 1 : -1;
        // chance to follow the pressure gradient proportional to its strength
        if (Math.random() < Math.min(1, Math.abs(push))) {
          if (this.tryMove(i, x, y, x + dx, y)) return;
        }
        // fallback to windBias influence
        if (Math.abs(windBias) > 0.2) {
          const wdx = windBias > 0 ? 1 : -1;
          if (this.tryMove(i, x, y, x + wdx, y)) return;
        }
        // final random attempt
        if (this.tryMove(i, x, y, x + dir, y)) return;
        this.tryMove(i, x, y, x - dir, y);
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
    // gases are strongly affected by pressure gradients; lighter gases move more
    const windBias = clamp(wind.x * 1.2 / (m.density ?? 0.1), -1, 1);

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
      let baseP = 0;

      if (id !== 0 && m.state === "gas") {
        // More gas + hotter => higher pressure
        baseP = 0.55;
        baseP += clamp((this.temp[i] - this.ambientT) / 400, -0.4, 0.6);
      } else if (id === 0) {
        // Air pressure gently follows temperature too
        baseP = 0.18 + clamp((this.temp[i] - this.ambientT) / 600, -0.15, 0.25);
      } else {
        // solids/liquids displace air: treat as slightly negative pressure pocket
        baseP = -0.05;
      }

      const injected = this.pressInject[i] || 0;
      const prev = this.press[i] || 0;

      // Preserve previous pressure so transient injections persist after the tool is released.
      // Start from previous pressure + injection, then more slowly relax toward the material/temperature-derived base.
      const raw = prev + injected;
      this.press2[i] = lerp(raw, baseP + injected, 0.02);
    }

    // Diffuse/relax pressure (increase diffusion so pressure propagates faster)
    const diff = 0.35;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        const pC = this.press2[i];
        const pL = this.press2[this.idx(clamp(x - 1, 0, this.w - 1), y)];
        const pR = this.press2[this.idx(clamp(x + 1, 0, this.w - 1), y)];
        const pU = this.press2[this.idx(x, clamp(y - 1, 0, this.h - 1))];
        const pD = this.press2[this.idx(x, clamp(y + 1, 0, this.h - 1))];

        const avg = (pL + pR + pU + pD) * 0.25;
        // relax pressure towards neighbors; diffusion rate `diff` controls speed
        this.press[i] = lerp(pC, avg, diff);
      }
    }
    // Diffuse and decay transient injections so pressure spreads out instead of vanishing.
    if (this.pressInject && this.pressInject.length === n) {
      const inject = this.pressInject;
      const next = new Float32Array(n);
      for (let y = 0; y < this.h; y++) {
        for (let x = 0; x < this.w; x++) {
          const i = this.idx(x, y);
          const center = inject[i] || 0;
          const left = inject[this.idx(clamp(x - 1, 0, this.w - 1), y)] || 0;
          const right = inject[this.idx(clamp(x + 1, 0, this.w - 1), y)] || 0;
          const up = inject[this.idx(x, clamp(y - 1, 0, this.h - 1))] || 0;
          const down = inject[this.idx(x, clamp(y + 1, 0, this.h - 1))] || 0;
          // average with neighbors to spread
          const avg = (center + left + right + up + down) * 0.2;
          // decay factor controls how long injected pressure lingers (slower decay)
          next[i] = avg * 0.985;
        }
      }
      // copy back into pressInject
      this.pressInject.set(next);
    }
  }

  // Apply pressure-driven effects after pressure diffusion
  applyPressureEffects(dt) {
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      const id = this.mat[i];
      if (id === 0) continue;
      const m = this.getMat(id);
      const p = this.press[i] || 0;

      // Solid breakage: if pressure exceeds material's threshold, break/transform
      if (m && m.state === 'solid' && m.pressureStrength != null && p >= m.pressureStrength) {
        const breakInto = (m.breakInto != null) ? m.breakInto : (m.decayInto != null ? m.decayInto : 0);
        this.mat[i] = breakInto;
        this.temp[i] += Math.min(p * 15, 400); // add shock heating
        this.press[i] = Math.max(0, p * 0.5); // partially relieve pressure
        this.updated[i] = 1;
        continue;
      }
    }
  }

  // Material scripting pass: execute compiled per-material scripts on a sparse set of cells.
  applyMaterialScripts(dt) {
    const n = this.w * this.h;
    const deferred = [];

    const resolveMaterialRef = (ref) => {
      if (ref == null) return 0;
      if (typeof ref === 'number') return ref;
      if (typeof ref === 'string') {
        const m = this.materialsByName[ref];
        if (m) return m.id;
        const num = Number(ref);
        if (!Number.isNaN(num)) return num;
      }
      if (typeof ref === 'object' && 'id' in ref) return ref.id;
      return 0;
    };

    const gameAPI = {
      getMat: (nameOrId) => {
        if (typeof nameOrId === 'number') return this.getMat(nameOrId);
        if (!nameOrId) return null;
        return this.materialsByName[nameOrId] || null;
      },
      triggerExplosion: (x, y, opts) => this.triggerExplosion(x, y, opts),
      spawnEntity: (x, y, materialRef, opts = {}) => {
        const mid = resolveMaterialRef(materialRef);
        const m = this.getMat(mid);
        if (!m || !m.entity) return false;
        const ent = { x: x, y: y, matId: m.id, age: 0 };
        if (opts.life) ent.life = opts.life;
        if (opts.vx) ent.vx = opts.vx;
        if (opts.vy) ent.vy = opts.vy;
        this.entities.push(ent);
        return true;
      },
      // Remove any entities whose integer position matches (x,y). Returns number removed.
      removeEntitiesAt: (x, y) => {
        let removed = 0;
        for (let ei = this.entities.length - 1; ei >= 0; ei--) {
          const e = this.entities[ei];
          if (Math.floor(e.x) === x && Math.floor(e.y) === y) {
            this.entities.splice(ei, 1);
            removed++;
          }
        }
        return removed;
      },
      now: () => this.tick
    };

    // Lightweight canvas API exposed to scripts (read/write via deferred ops)
    const makeCanvasAPI = (cellThis) => ({
      get: (x, y) => {
        if (!this.inb(x, y)) return null;
        const ii = this.idx(x, y);
        return { x, y, matId: this.mat[ii], temp: this.temp[ii], pressure: this.press[ii] };
      },
      set: (x, y, materialRef) => {
        if (!this.inb(x, y)) return false;
        const mid = resolveMaterialRef(materialRef);
        deferred.push({ op: 'set', x, y, mid });
        return true;
      },
      removeEntitiesAt: (x, y) => {
        let removed = 0;
        for (let ei = this.entities.length - 1; ei >= 0; ei--) {
          const e = this.entities[ei];
          if (Math.floor(e.x) === x && Math.floor(e.y) === y) {
            this.entities.splice(ei, 1);
            removed++;
          }
        }
        return removed;
      },
      replace: (x, y, materialRef) => {
        if (!this.inb(x, y)) return false;
        const mid = resolveMaterialRef(materialRef);
        deferred.push({ op: 'replace', x, y, mid });
        return true;
      },
      find_particles: (cx, cy, range = 1, filter = null, limit = 64) => {
        const res = [];
        const r = Math.max(0, Math.floor(range));
        for (let dy = -r; dy <= r && res.length < limit; dy++) {
          for (let dx = -r; dx <= r && res.length < limit; dx++) {
            const x = cx + dx, y = cy + dy;
            if (!this.inb(x, y)) continue;
            const ii = this.idx(x, y);
            const info = { x, y, matId: this.mat[ii], temp: this.temp[ii], pressure: this.press[ii] };
            if (typeof filter === 'function') {
              try { if (!filter(info)) continue; } catch(e) { continue; }
            }
            res.push(info);
          }
        }
        return res;
      },
      replace_particle: (pos, materialRef) => {
        if (!pos) return false;
        const x = pos.x ?? pos[0], y = pos.y ?? pos[1];
        return makeCanvasAPI(cellThis).set(x, y, materialRef);
      },
      forEachNeighbor: (x, y, cb) => {
        for (let ny = y - 1; ny <= y + 1; ny++) {
          for (let nx = x - 1; nx <= x + 1; nx++) {
            if (nx === x && ny === y) continue;
            if (!this.inb(nx, ny)) continue;
            const ii = this.idx(nx, ny);
            const info = { x: nx, y: ny, matId: this.mat[ii], temp: this.temp[ii], pressure: this.press[ii] };
            try { cb(info); } catch (e) { /* swallow */ }
          }
        }
      }
    });

    // helpers API (small utilities)
    const makeHelpers = (cellThis, tick) => ({ rand: () => Math.random(), vecTo: (x1,y1,x2,y2) => { const dx = x2-x1, dy = y2-y1; return { dx, dy, dist: Math.hypot(dx,dy) }; } });

    // iterate grid, run scripts sparsely
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        const id = this.mat[i];
        if (!id) continue;
        const m = this.getMat(id);
        if (!m || !m.compiledScript || !m._scriptEnabled) continue;

        // throttling: per-material tickInterval or probabilistic sampleRate
        const interval = Math.max(1, m.scriptInterval || 16);
        if (((x + y + this.tick) % interval) !== 0) continue;
        if (m.sampleRate < 1.0 && Math.random() > m.sampleRate) continue;

        // build cell 'this' object
        const cellThis = {
          x, y, mat: m, temp: this.temp[i], pressure: this.press[i], _deferred: []
        };
        cellThis.defer = (fn) => { try { fn(); } catch (e) { /* swallow */ } };

        const canvasAPI = makeCanvasAPI(cellThis);
        const helpers = makeHelpers(cellThis, this.tick);

        try {
          // limited debug logging for first few runs
          if (m._scriptRunCount < 6) {
            console.debug(`Running script '${m.name}' at (${x},${y}) tick=${this.tick}`);
          }
          m._scriptRunCount = (m._scriptRunCount || 0) + 1;
          // call compiled script with `this` = cellThis
          m.compiledScript.call(cellThis, gameAPI, canvasAPI, helpers, m.scriptParams || {}, this.tick);
        } catch (e) {
          console.error(`Error in material script '${m.name}' at (${x},${y}):`, e);
          // disable further runs for noisy scripts
          m._scriptEnabled = false;
        }

        // Persist any temperature/pressure mutations made on the `this` object back to the simulation arrays.
        try {
          if (typeof cellThis.temp === 'number') this.temp[i] = cellThis.temp;
          if (typeof cellThis.pressure === 'number') this.press[i] = cellThis.pressure;
        } catch (e) {
          // non-fatal
        }
      }
    }

    // Apply deferred ops
    for (const op of deferred) {
      const ii = this.idx(op.x, op.y);
      if (op.op === 'set' || op.op === 'replace') {
        this.mat[ii] = op.mid;
        this.updated[ii] = 1;
      }
    }
  }

    // --- Recipe system (moved from recipe.js) ---
    // Build/normalize recipes list; materialsByName may be provided to resolve names to IDs
    buildRecipesTable(recipes, materialsByName) {
      const out = [];
      for (const r of (Array.isArray(recipes) ? recipes : [recipes])) {
        if (!r || !r.name) continue;
        const clone = { ...r };
        clone.inputs = (r.inputs || []).map(inp => ({
          mat: inp.mat,
          count: Number(inp.count || 1),
          radius: Math.max(0, Math.floor(inp.radius || 1))
        }));
        if (materialsByName) {
          for (const inp of clone.inputs) {
            if (typeof inp.mat === 'string') {
              const m = materialsByName[inp.mat];
              inp.matId = m ? m.id : null;
            } else if (typeof inp.mat === 'number') inp.matId = inp.mat;
            else inp.matId = null;
          }
          if (clone.result && typeof clone.result.mat === 'string') {
            const m = materialsByName[clone.result.mat];
            clone.resultMatId = m ? m.id : null;
          } else if (clone.result && typeof clone.result.mat === 'number') {
            clone.resultMatId = clone.result.mat;
          }
        }
        clone.tempMin = (r.tempMin == null) ? -Infinity : Number(r.tempMin);
        clone.tempMax = (r.tempMax == null) ? Infinity : Number(r.tempMax);
        clone.pressMin = (r.pressMin == null) ? -Infinity : Number(r.pressMin);
        clone.pressMax = (r.pressMax == null) ? Infinity : Number(r.pressMax);
        clone.chance = (r.chance == null) ? 1.0 : Number(r.chance);
        clone.interval = Math.max(1, Number(r.interval || 8));
        clone.sampleRate = (r.sampleRate == null) ? 1.0 : Number(r.sampleRate);
        out.push(clone);
      }
      return out;
    }

    // Count occurrences of a material id within Manhattan radius `radius`
    _countNeighbors(sim, x, y, matId, radius) {
      let c = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > radius) continue;
          const nx = x + dx, ny = y + dy;
          if (!sim.inb(nx, ny)) continue;
          const ii = sim.idx(nx, ny);
          if (sim.mat[ii] === matId) c++;
        }
      }
      return c;
    }

    _matchRecipeAt(sim, recipe, x, y) {
      if (recipe.sampleRate < 1.0 && Math.random() > recipe.sampleRate) return false;
      const i = sim.idx(x, y);
      const t = sim.temp[i];
      const p = sim.press[i] || 0;
      if (t < recipe.tempMin || t > recipe.tempMax) return false;
      if (p < recipe.pressMin || p > recipe.pressMax) return false;
      for (const inp of (recipe.inputs || [])) {
        const matId = (inp.matId != null) ? inp.matId : (typeof inp.mat === 'number' ? inp.mat : null);
        if (matId == null) return false;
        const c = this._countNeighbors(sim, x, y, matId, inp.radius || 1);
        if (c < (inp.count || 1)) return false;
      }
      if (recipe.chance < 1.0 && Math.random() > recipe.chance) return false;
      return true;
    }

    findRecipeMatches(sim, recipes) {
      const matches = [];
      for (let y = 0; y < sim.h; y++) {
        for (let x = 0; x < sim.w; x++) {
          const i = this.idx(x, y);
          const id = this.mat[i];
          if (id === 0) continue;
          for (const r of recipes) {
            if (((x + y + this.tick) % r.interval) !== 0) continue;
            if (this._matchRecipeAt(sim, r, x, y)) matches.push({ x, y, recipe: r });
          }
        }
      }
      return matches;
    }

    applyRecipeMatches(sim, matches) {
      let applied = 0;
      for (const m of matches) {
        const r = m.recipe; const x = m.x, y = m.y; const i = sim.idx(x, y);
        const targetId = (r.resultMatId != null) ? r.resultMatId : (r.result && typeof r.result.mat === 'number' ? r.result.mat : null);
        if (targetId == null) continue;
        if (r.result && r.result.consumeInputs) {
          for (const inp of (r.inputs || [])) {
            const matId = inp.matId; if (matId == null) continue;
            let need = inp.count || 1;
            for (let dy = -inp.radius; dy <= inp.radius && need > 0; dy++) {
              for (let dx = -inp.radius; dx <= inp.radius && need > 0; dx++) {
                if (Math.abs(dx) + Math.abs(dy) > inp.radius) continue;
                const nx = x + dx, ny = y + dy; if (!sim.inb(nx, ny)) continue;
                const ii = sim.idx(nx, ny);
                if (sim.mat[ii] === matId) { sim.mat[ii] = 0; sim.temp[ii] = sim.ambientT; sim.updated[ii] = 1; need--; }
              }
            }
          }
        }
        sim.mat[i] = targetId;
        if (r.result) {
          if (typeof r.result.temp === 'number') sim.temp[i] = r.result.temp;
          if (typeof r.result.press === 'number') sim.press[i] = r.result.press;
        }
        sim.updated[i] = 1;
        applied++;
      }
      return applied;
    }

  updateTemperature(dt) {
    // Diffuse temperature with material conductivity and heat capacity
    const n = this.w * this.h;

    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        const id = this.mat[i];
        const m = this.getMat(id);

        const k = clamp(m.conductivity*30 ?? 0.2, 0, 1);
        const cap = Math.max(0.1, m.heatCapacity ?? 1);

        const tC = this.temp[i];

        // Diffuse temperature preferentially into nearby materials (exclude Air neighbors)
        // Use 8-neighborhood and weight transfer by averaged conductivity between cells.
        const neigh8 = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
        let sumT = 0, sumW = 0;
        for (const off of neigh8) {
          const nx = x + off[0], ny = y + off[1];
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
          const ii = this.idx(nx, ny);
          const nid = this.mat[ii];
          // Skip air neighbors entirely so heat stays within materials
          if (nid === 0) continue;
          const nm = this.getMat(nid);
          const nt = this.temp[ii];
          const nk = clamp(nm.conductivity*300 ?? 0.18, 0, 1);
          // weight based on average conductivity; diagonals count a bit less
          let w = (k + nk) * 0.5;
          if (off[0] !== 0 && off[1] !== 0) w *= 0.707; // diagonal distance factor
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

    // precompute rgb for materials for speed (map by material id)
    if (!this._matRGBById) this._matRGBById = new Map();
    // Refresh map if number of materials changed or any missing ids
    if (this._matRGBById.size !== this.materials.length) {
      this._matRGBById = new Map();
      for (const m of this.materials) this._matRGBById.set(m.id, hexToRgb(m.color || "#000"));
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

      const baseRgb = this._matRGBById.get(id) || { r: 0, g: 0, b: 0 };
      let { r, g, b } = baseRgb;

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
        const ex = Math.floor(ent.x), ey = Math.floor(ent.y);
        if (!this.inb(ex, ey)) continue;
        const i = this.idx(ex, ey);
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

    // Draw move-tool ghost overlay (follow cursor while dragging, non-destructive)
    try {
      if (this._moveActive && this._moveBuffer && this._movePlacedAt) {
        this.ctx.save();
        this.ctx.globalAlpha = 0.95;
        for (const c of this._moveBuffer) {
          if (!c || c.mat == null) continue;
          if (c.mat === 0) continue;
          const tx = this._movePlacedAt.x + c.dx, ty = this._movePlacedAt.y + c.dy;
          if (!this.inb(tx, ty)) continue;
          const rgb = (this._matRGBById && this._matRGBById.get(c.mat)) || hexToRgb(this.getMat(c.mat)?.color || '#000');
          this.ctx.fillStyle = `rgba(${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)},0.95)`;
          this.ctx.fillRect(tx, ty, 1, 1);
        }
        this.ctx.restore();
      }
    } catch (e) { /* non-fatal */ }

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

    // Draw brush preview (outline circle) if UI provided a brush radius and cursor
    try {
      if (this._ui && this.cursor) {
        const r = Math.max(1, this._ui.brushRadius || 1);
        const cx = this.cursor.x + 0.5;
        const cy = this.cursor.y + 0.5;
        const selId = this._ui.selectedMat;
        const col = (this._matRGBById && this._matRGBById.get(selId)) || { r: 255, g: 255, b: 255 };
        this.ctx.save();
        this.ctx.strokeStyle = `rgba(${col.r},${col.g},${col.b},0.95)`;
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
        this.ctx.stroke();
        this.ctx.restore();
      }
    } catch (e) { /* non-fatal */ }
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

  let nx = ent.x + dx * speed;
  let ny = ent.y + dy * speed;
  // If the neutron moves outside the grid, respect edgeMode: in 'void' mode remove it.
  if (!sim.inb(Math.floor(nx), Math.floor(ny))) {
    if (sim.edgeMode === 'void') {
      const ei = ctx.ei; if (ei != null && sim.entities[ei] === ent) sim.entities.splice(ei,1);
      return;
    }
    nx = clamp(nx, 0, sim.w - 1);
    ny = clamp(ny, 0, sim.h - 1);
  }
  ent.x = nx; ent.y = ny;
  // use integer cell coordinates for grid interactions
  const ix = clamp(Math.floor(ent.x), 0, sim.w - 1);
  const iy = clamp(Math.floor(ent.y), 0, sim.h - 1);
  const idx = sim.idx(ix, iy);
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

  // Deuterium handling: allow material script to control neutron interaction.
  if (targetMat && targetMat.deuterium) {
    // If material has a compiled script, invoke it synchronously and act on its return value.
    if (targetMat.compiledScript) {
      try {
        const cellThis = { x: ix, y: iy, mat: targetMat, temp: this.temp[idx], pressure: this.press[idx] };
        const gameAPI = {
          getMat: (n) => (typeof n === 'string' ? this.materialsByName[n] : this.getMat(n)),
          spawnEntity: (x,y,materialRef, opts = {}) => {
            const mid = (typeof materialRef === 'string' ? (this.materialsByName[materialRef] && this.materialsByName[materialRef].id) : materialRef);
            if (!mid && mid !== 0) return false;
            const entObj = { x: x, y: y, matId: mid, age: 0 };
            if (opts.life) entObj.life = opts.life;
            if (opts.vx) entObj.vx = opts.vx;
            if (opts.vy) entObj.vy = opts.vy;
            this.entities.push(entObj);
            return true;
          },
          now: () => this.tick
        };
        const canvasAPI = {
          get: (x,y) => { if (!this.inb(x,y)) return null; const ii = this.idx(x,y); return { x, y, matId: this.mat[ii], temp: this.temp[ii], pressure: this.press[ii] }; },
          set: (x,y,materialRef) => { if (!this.inb(x,y)) return false; const mid = (typeof materialRef === 'string' ? (this.materialsByName[materialRef] && this.materialsByName[materialRef].id) : materialRef); if (!mid && mid !== 0) return false; this.mat[this.idx(x,y)] = mid; this.updated[this.idx(x,y)] = 1; return true; },
          replace: (x,y,materialRef) => { return canvasAPI.set(x,y,materialRef); }
        };
        const helpers = { rand: () => Math.random(), randint: (a,b) => (a + Math.floor(Math.random() * (b - a + 1))) };

        const res = targetMat.compiledScript.call(cellThis, gameAPI, canvasAPI, helpers, targetMat.scriptParams || {}, this.tick);
        // persist any temp/pressure changes the script made to `this`
        if (typeof cellThis.temp === 'number') this.temp[idx] = cellThis.temp;
        if (typeof cellThis.pressure === 'number') this.press[idx] = cellThis.pressure;

        // Handle script return directives
        const ei = ctx.ei;
        if (res && res.absorbNeutron) {
          if (ei != null && this.entities[ei] === ent) this.entities.splice(ei,1);
          return;
        }
        if (res && typeof res.fission === 'number' && res.fission > 0) {
          const nid = this.materialsByName && this.materialsByName['Neutron'] ? this.materialsByName['Neutron'].id : 9;
          for (let k = 0; k < res.fission; k++) {
            const rx = clamp(ix + (Math.floor(Math.random()*3)-1) + (Math.random()-0.5), 0, this.w-1);
            const ry = clamp(iy + (Math.floor(Math.random()*3)-1) + (Math.random()-0.5), 0, this.h-1);
            this.entities.push({ x: rx, y: ry, matId: nid, age: 0, life: 300 });
          }
          if (res.consumeSelf) { this.mat[idx] = 0; this.updated[idx] = 1; }
          if (ei != null && this.entities[ei] === ent) this.entities.splice(ei,1);
          return;
        }
      } catch (e) {
        console.error('Error in Deuterium neutron-script:', e);
      }
    }

    // Fallback: simple absorb behavior if no script provided
    if (Math.random() < 0.3) {
      this.temp[idx] += 50;
    } else {
      const nid = this.materialsByName && this.materialsByName['Neutron'] ? this.materialsByName['Neutron'].id : 9;
      for (let k=0;k<3;k++) {
        const rx = clamp(ix + (Math.floor(Math.random()*3)-1) + (Math.random()-0.5), 0, this.w-1);
        const ry = clamp(iy + (Math.floor(Math.random()*3)-1) + (Math.random()-0.5), 0, this.h-1);
        this.entities.push({ x: rx, y: ry, matId: nid, age: 0, life: 300 });
      }
      this.mat[idx] = 0;
    }
    const ei = ctx.ei; if (ei != null && this.entities[ei] === ent) this.entities.splice(ei,1);
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
        const sx = clamp(ix + (Math.random()-0.5), 0, sim.w-1);
        const sy = clamp(iy + (Math.random()-0.5), 0, sim.h-1);
        sim.entities.push({ x: sx, y: sy, matId: nid, age: 0, life: 300 });
      }
      sim.temp[idx] += 40;
      sim.addPressure(idx, 4.0);
      // nudge neighbors
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const xx = clamp(ix+ox,0,sim.w-1), yy = clamp(iy+oy,0,sim.h-1);
        const ii = sim.idx(xx,yy); if (ii === idx) continue;
        sim.temp[ii] += 8 * (1 - (Math.abs(ox)+Math.abs(oy))/4);
        sim.addPressure(ii, 1.0);
      }
      const ei = ctx.ei; if (ei != null && sim.entities[ei] === ent) sim.entities.splice(ei,1);
      return;
    }
  }

  // Explosive materials trigger via applyChemistry, but still remove neutron
  if (targetMat && targetMat.explosive) {
    sim.temp[idx] += (targetMat.explodeHeatBoost ?? 40);
    if (sim.temp[idx] >= (targetMat.explodeTemp || 280)) sim.triggerExplosion(ent.x, ent.y, { radius: targetMat.explosionRadius ?? 5, strength: targetMat.explosionStrength ?? 12, blastPressure: (targetMat.blastPressure != null ? targetMat.blastPressure : 1.0) });
  }

  // default: neutrons pass through non-absorbing materials (no automatic removal)
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
          if (mid !== 0) {
            const mm = sim.getMat(mid);
            // prefer non-entity target materials (don't select another emitter/neutron as target)
            if (mm && mm.entity) continue;
            ent._targetMat = mid; break;
          }
      }
      if (ent._targetMat != null) break;
    }
    // If no grid material found, look for adjacent entities and use their material id as target
    if (ent._targetMat == null && sim.entities && sim.entities.length > 0) {
      for (let ei = 0; ei < sim.entities.length; ei++) {
        const e = sim.entities[ei];
        const ex = Math.floor(e.x), ey = Math.floor(e.y);
        if (Math.abs(ex - Math.floor(ent.x)) <= 1 && Math.abs(ey - Math.floor(ent.y)) <= 1) {
          if (e.matId) {
            // avoid adopting another emitter as the target (prevents runaway emitter cloning)
            const candMat = sim.getMat(e.matId);
            if (candMat && candMat.behavior === 'emitter') continue;
            ent._targetMat = e.matId; break;
          }
        }
      }
    }
  }

  // If no target yet, do nothing
  if (ent._targetMat == null) return;

  // place target material in a ring (8 neighbors). Only place into air cells.
  const ex = Math.floor(ent.x);
  const ey = Math.floor(ent.y);
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const nx = ex + ox;
      const ny = ey + oy;
      if (!sim.inb(nx, ny)) continue;
      const ii = sim.idx(nx, ny);
      const targetMat = sim.getMat(ent._targetMat);
      if (targetMat && targetMat.entity) {
        // spawn an entity of that material at the neighbor cell
        // prevent emitters from spawning other emitters
        if (targetMat.behavior === 'emitter') continue;
        const entObj = { x: nx, y: ny, matId: ent._targetMat, age: 0 };
        // give a tiny random velocity if behavior wants it
        if (!entObj.vx && targetMat.behavior === 'neutron') {
          entObj.vx = (Math.random() - 0.5) * 2;
          entObj.vy = (Math.random() - 0.5) * 2;
        }
        // respect lifetime if provided on material behaviorParams
        if (targetMat.behaviorParams && targetMat.behaviorParams.lifetime) entObj.life = targetMat.behaviorParams.lifetime;
        sim.entities.push(entObj);
      } else {
        if (sim.mat[ii] === 0) {
          sim.mat[ii] = ent._targetMat;
          // set temperature to the material's default or a small nudge
          const m = targetMat;
          sim.temp[ii] = (m && m.defaultTemp != null) ? m.defaultTemp : sim.ambientT + 10;
          sim.updated[ii] = 1;
        }
      }
    }
  }
};

function buildUI(sim) {
  const $ = (id) => document.getElementById(id);

  const matSelect = $("matSelect");
  const categoryList = $("categoryBox");
  const materialsGrid = $("materialsBar");
  // Use the static search frame/input from the DOM (created in index.html)
  const searchFrame = $("searchFrame");
  const searchInput = (searchFrame && (searchFrame.querySelector('#searchFilter') || searchFrame.querySelector('input'))) || null;
  const selectedMatShort = $("selectedMatShort");
  if (searchInput) searchInput.style.display = 'none';
  // create a category-mounted SEARCH button (the input lives in the materials bar)
  const searchCategoryBtn = document.createElement('button');
  searchCategoryBtn.className = 'category-btn';
  searchCategoryBtn.textContent = 'SEARCH';
  searchCategoryBtn.style.color = '#ffd66b';
  searchCategoryBtn.style.borderColor = '#ffd66b';
  searchCategoryBtn.dataset.cat = 'search';
  searchCategoryBtn.addEventListener('click', () => {
    selectCategory('search');
    // show and focus the input that lives in the materials bar
    searchInput.style.display = 'inline-block';
    searchInput.focus();
  });
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
  const edgeMode = $("edgeMode");
  const blastPressure = $("blastPressure");
  const blastPressureVal = $("blastPressureVal");
  const status = $("status");
  const legend = $("legend");

  // Track Tab key held state for combos (Tab+Q to clear)
  let tabHeld = false;

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
    metal: "#424d66",
    powder: "#c7b07a",
    nuclear: "#b23fff",
    liquid: "#3a78ff",
    gas: "#a7adb6",
    organic: "#81ff4f",
    special: "#ff4f8a",
    tool: "#f3ff4f",
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
    // static search frame is provided in index.html; no need to place it inside materialsGrid
    // Ensure the SEARCH button exists in the category column (one-time insert)
    if (searchCategoryBtn && categoryList && !categoryList.contains(searchCategoryBtn)) categoryList.appendChild(searchCategoryBtn);
    // auto-select first
    if (!currentCategory && categories.length) currentCategory = categories[0];
    selectCategory(currentCategory);
  }

  function selectCategory(state) {
    currentCategory = state;
    for (const b of categoryList.children) {
      // ignore the search input element
      if (!b.dataset) continue;
      b.classList.toggle("selected", b.dataset.cat === state);
    }
    // show or hide search input frame
    if (state === 'search') {
      if (searchFrame) searchFrame.style.display = 'flex';
      if (searchInput) { searchInput.style.display = 'inline-block'; searchInput.focus(); }
    } else {
      if (searchFrame) searchFrame.style.display = 'none';
      if (searchInput) searchInput.value = '';
    }
    refreshMaterialsGrid(state);
  }

  function refreshMaterialsGrid(state) {
    // Remove all material children but preserve the static searchFrame so typing doesn't lose focus
    if (materialsGrid) {
      // remove all children (materials only)
      materialsGrid.innerHTML = "";
    }
    let mats;
    if (state === 'search') {
      const q = (searchInput.value || '').trim().toLowerCase();
      if (!q) mats = [];
      else mats = sim.materials.filter(m => {
        const name = (m.name || '').toLowerCase();
        const cat = ((m.category || m.state) || '').toLowerCase();
        return name.includes(q) || cat.includes(q);
      });
    } else {
      mats = sim.materials.filter(m => (m.category || m.state) === state);
    }
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
        sim._matRGBById = null;
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
    fields.push(makeField("blastPressure", "blastPressure", "number"));
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
      sim._matRGBById = null;
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
    if (blastPressure && blastPressureVal) blastPressureVal.textContent = (Number(blastPressure.value)/100).toFixed(2) + "x";
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
  if (blastPressure) {
    blastPressure.addEventListener('input', () => {
      sim.blastPressure = Number(blastPressure.value) / 100;
      updateLabels();
    });
    // init value
    blastPressure.value = String(Math.round((sim.blastPressure || 1.0) * 100));
  }
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
  if (edgeMode) {
    edgeMode.addEventListener('change', () => sim.edgeMode = edgeMode.value || 'walled');
    edgeMode.value = sim.edgeMode || 'walled';
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

  // Hook search input to update results live
  searchInput.addEventListener('input', () => {
    if (currentCategory === 'search') refreshMaterialsGrid('search');
  });

  exportBtn.addEventListener("click", () => {
    exportBox.value = JSON.stringify(sim.materials, null, 2);
    exportBox.focus();
    exportBox.select();
  });
  resetBtn.addEventListener("click", () => {
    sim.materials = structuredClone(DEFAULT_MATERIALS);
    sim.materialsById = new Map(sim.materials.map(m => [m.id, m]));
    sim.materialsByName = Object.fromEntries(sim.materials.map(m => [m.name, m]));
    sim._matRGBById = null;
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
    // Update the selected material short description (UI quick label)
    if (selectedMatShort) {
      try {
        selectedMatShort.textContent = (sel && (sel.description_short || sel.short || sel.name)) || '';
      } catch (e) { /* ignore */ }
    }
    status.textContent =
      `FPS: ${lastFPS}   Cells: ${sim.w}x${sim.h}   Speed: ${speed.value}x\n` +
      `Selected: ${sel.id} ${sel.name} (${sel.state})   Brush: ${brushSize.value}`;
    // show hovered material under cursor if available
    if (sim.cursor) {
      const ci = sim.idx(sim.cursor.x, sim.cursor.y);
      const underId = sim.mat[ci];
      const underMat = sim.getMat(underId);
      // Gather extra info for hovered cell
      const temp = sim.temp[ci];
      const pres = sim.press[ci] || 0;
      const flags = [];
      if (underMat) {
        if (underMat.nuclear) flags.push('nuclear');
        //if (underMat.deuterium) flags.push('deuterium');
        if (underMat.explosive) flags.push('explosive');
        if (underMat.burnable) flags.push('burnable');
        if (underMat.entity) flags.push('entity');
        if (underMat.moderator) flags.push('moderator');
        if (underMat.neutronReflector) flags.push('reflector');
        if (underMat.neutronAbsorber) flags.push('absorber');
      }
      status.textContent += `   | Under: ${underId} ${underMat ? underMat.name : 'Air'} (${underMat ? underMat.state : 'gas'})`;
      status.textContent += `  T:${temp.toFixed(1)}°C P:${pres.toFixed(2)}`;
      if (flags.length) status.textContent += ` [${flags.join(',')}]`;
    }

    legend.textContent =
      `Temp: shift=heat, alt=cool. Shift/Ctrl adjust brush size; Space toggles pause.\n` +
      `Overlays show relative fields. Tip: paint lava under water for steam + convection-like motion.`;

    requestAnimationFrame(uiTick);
  }
  requestAnimationFrame(uiTick);

  // Keybindings: 1=regular, 2=fancy, 3=temperature view, 4=pressure view
  window.addEventListener('keydown', (ev) => {
    // ignore when typing in inputs/textareas
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

    // Track Tab being held down for combo usage
    if (ev.key === 'Tab') {
      tabHeld = true;
      ev.preventDefault();
      return;
    }

    // Speed controls: comma = slower, dot = faster
    if (ev.key === ',') {
      if (speed) {
        let val = Number(speed.value) || 1;
        val = clamp(val - 1, Number(speed.min) || 1, Number(speed.max) || 8);
        speed.value = String(val);
        speed.dispatchEvent(new Event('input', { bubbles: true }));
      }
      ev.preventDefault();
      return;
    }
    if (ev.key === '.') {
      if (speed) {
        let val = Number(speed.value) || 1;
        val = clamp(val + 1, Number(speed.min) || 1, Number(speed.max) || 8);
        speed.value = String(val);
        speed.dispatchEvent(new Event('input', { bubbles: true }));
      }
      ev.preventDefault();
      return;
    }

    // Tab+Q: clear the screen
    if ((ev.key === 'q' || ev.key === 'Q') && tabHeld) {
      sim.clear();
      ev.preventDefault();
      return;
    }

    // Space: toggle pause
    if (ev.code === 'Space') {
      sim.paused = !sim.paused;
      pauseBtn.textContent = sim.paused ? "Resume" : "Pause";
      ev.preventDefault();
      return;
    }

    // Shift/Ctrl quick brush sizing
    if (ev.key === 'Shift') {
      const bs = brushSize;
      if (bs) {
        let val = Number(bs.value) || 1;
        val = clamp(val + 1, Number(bs.min) || 1, Number(bs.max) || 12);
        bs.value = String(val);
        bs.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (ev.key === 'Control') {
      const bs = brushSize;
      if (bs) {
        let val = Number(bs.value) || 1;
        val = clamp(val - 1, Number(bs.min) || 1, Number(bs.max) || 12);
        bs.value = String(val);
        bs.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }

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

  // Clear Tab-held flag on keyup so combos work reliably
  window.addEventListener('keyup', (ev) => {
    if (ev.key === 'Tab') tabHeld = false;
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

    const matObj = sim.getMat(matId);
    // Special-case move tool to invoke once at center instead of per-cell
    if (matObj && matObj.isTool && matObj.toolType === 'move') {
      if (heat) sim.applyTool('move', x, y, matObj.toolRadius || r, 1, matObj);
      else if (cool) sim.applyTool('move', x, y, matObj.toolRadius || r, 1, matObj);
      else if (button === 2) sim.applyTool('move', x, y, matObj.toolRadius || r, 1, matObj);
      else sim.applyTool('move', x, y, matObj.toolRadius || r, 1, matObj);
      return;
    }

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

  // Pointer events: update cursor and support touch drawing
  canvas.addEventListener('pointermove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - rect.left) / rect.width * sim.w);
    const y = Math.floor((ev.clientY - rect.top) / rect.height * sim.h);
    sim.cursor = { x: clamp(x, 0, sim.w - 1), y: clamp(y, 0, sim.h - 1) };
    if (down && ev.pointerType !== 'mouse') {
      paintAt(ev);
    }
  });

  canvas.addEventListener('pointerdown', (ev) => {
    down = true;
    button = ev.button || 0;
    paintAt(ev);
  }, { passive: false });
  window.addEventListener('pointerup', () => { down = false; if (sim && typeof sim.finishMove === 'function') sim.finishMove(true); });

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

  window.addEventListener("mouseup", () => { down = false; if (sim && typeof sim.finishMove === 'function') sim.finishMove(true); });

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
  // expose UI to sim so render can show brush preview
  sim._ui = ui;
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
