// Material presets. You can edit in the UI and export JSON.
// Fields used by the sim:
//
// name: string
// state: "solid" | "liquid" | "gas"
// color: base hex color
// colorVar: 0..1 random variation applied per cell
// density: relative density (higher = sinks more, resists pressure/wind)
// powder: 0..1 how "granular" a solid behaves (0=rigid-ish, 1=sand-like)
// viscosity: 0..1 (liquids) higher = flows less
// dispersion: 0..1 (gases) higher = spreads faster
// conductivity: 0..1 temperature diffusion coupling
// heatCapacity: >0 (higher = temperature changes slower)
// heatSource: °C per tick added (can be negative for cooling)
// decayChance: 0..1 chance per second to decay/transform
// decayInto: material id to decay into (0 = Air)
// meltTemp: °C, meltInto: material id
// freezeTemp: °C, freezeInto: material id
// boilTemp: °C, boilInto: material id
// condenseTemp: °C, condenseInto: material id
//
// Note: material ids are array indices. 0 is reserved for "Air"/empty.
//

// If a material object is missing human-readable descriptions, fill sensible
// defaults here so the UI can show tooltips/help without modifying each
// material entry manually.
function buildMaterialsTable(materialTables) {
  const density_mult = 1
  const AIR = {
    id: 0,
    name: "Air",
    short: "AIR ",
    state: "gas",
    color: "#000000",
    colorVar: 0.0,
    density: 0.08,
    powder: 0.0,
    viscosity: 0.0,
    dispersion: 0.85,
    conductivity: 0.18,
    heatCapacity: 1.0,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: 0,
    meltTemp: null, meltInto: 0,
    freezeTemp: null, freezeInto: 0,
    boilTemp: null, boilInto: 0,
    condenseTemp: null, condenseInto: 0
  };

  const tables = Array.isArray(materialTables) ? materialTables : [materialTables];
  const flat = [];
  for (const t of tables) {
    if (!t) continue;
    if (!Array.isArray(t)) throw new Error("buildMaterialsTable: expected an array (or array of arrays) of material objects.");
    for (const m of t) if (m) flat.push(m);
  }

  // Normalize and remove any user-provided Air to avoid duplicates; Air is always injected as ID 0.
  const materials = [];
  for (const m of flat) {
    const name = typeof m.name === "string" ? m.name.trim() : "";
    if (!name) throw new Error("buildMaterialsTable: every material must have a non-empty string 'name'.");
    if (name.toLowerCase() === "air") continue;

    // Shallow clone to avoid mutating input; drop/ignore any provided id.
    const cloned = { ...m };
    delete cloned.id;
    materials.push(cloned);
  }

  // Enforce unique names (case-insensitive), since transforms resolve by name.
  const seen = new Map(); // lowerName -> originalName
  for (const m of materials) {
    const key = m.name.trim().toLowerCase();
    if (seen.has(key)) {
      throw new Error(
        `buildMaterialsTable: duplicate material name '${m.name}'. Names must be unique (case-insensitive) to resolve *Into targets.`
      );
    }
    seen.set(key, m.name.trim());
  }

  // Assign IDs: Air=0, then 1..N in input order.
  const nameToId = new Map();
  nameToId.set("air", 0);

  const out = [AIR];
  let nextId = 1;
  for (const m of materials) {
    const nameKey = m.name.trim().toLowerCase();
    const assigned = {
      ...m,
      id: nextId++,
      density: (m.density ?? 0) * density_mult
    };
    out.push(assigned);
    nameToId.set(nameKey, assigned.id);
  }

  // Helper: resolve target for *Into fields. Prefer string names; allow 0/null.
  function resolveInto(value, fieldName, ownerName) {
    if (value == null) return 0; // treat null/undefined as "Air"/none
    if (typeof value === "number") {
      if (value === 0) return 0;
      throw new Error(
        `buildMaterialsTable: '${ownerName}.${fieldName}' is a nonzero number (${value}). ` +
        `IDs are auto-assigned; use a material name string instead (or 0 for Air).`
      );
    }
    if (typeof value === "string") {
      const key = value.trim().toLowerCase();
      if (!key) return 0;
      const id = nameToId.get(key);
      if (id == null) {
        throw new Error(
          `buildMaterialsTable: '${ownerName}.${fieldName}' refers to '${value}', but no material with that name exists.`
        );
      }
      return id;
    }
    throw new Error(
      `buildMaterialsTable: '${ownerName}.${fieldName}' must be a string material name, 0, or null/undefined.`
    );
  }

  // Fix transform fields after all IDs exist.
  for (const m of out) {
    const ownerName = m.name;

    if ("decayInto" in m) m.decayInto = resolveInto(m.decayInto, "decayInto", ownerName);

    if ("meltInto" in m) m.meltInto = resolveInto(m.meltInto, "meltInto", ownerName);
    if ("freezeInto" in m) m.freezeInto = resolveInto(m.freezeInto, "freezeInto", ownerName);
    if ("boilInto" in m) m.boilInto = resolveInto(m.boilInto, "boilInto", ownerName);
    if ("condenseInto" in m) m.condenseInto = resolveInto(m.condenseInto, "condenseInto", ownerName);

    // Ensure every material has a short and long description for UI/tooltips.


    // If temps are omitted, keep them as-is. If you want, you can also normalize missing *Into fields to 0 here.
  }

  return out;
}


const MATERIALS = [
  {
    name: "Air",
    short: "AIR ",
    description_short: "Light, invisible gas that fills empty space and lets other materials move.",
    state: "gas",
    color: "#000000",
    colorVar: 0.0,
    density: 0.08,
    powder: 0.0,
    viscosity: 0.0,
    dispersion: 0.85,
    conductivity: 0.18,
    heatCapacity: 1.0,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Sand",
    short: "SAND",
    description_short: "A granular powder that falls and can melt into molten glass.",
    state: "powder",
    color: "#c7b07a",
    colorVar: 0.18,
    density: 2.5,
    powder: 0.95,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.22,
    heatCapacity: 1.3,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: 1700, meltInto: "Molten Glass",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Neutron",
    short: "NEUT",
    description_short: "A fast-moving nuclear particle entity that disperses widely and can trigger fission interactions.",
    state: "gas",
    category: "nuclear",
    color: "#2f8cff",
    colorVar: 0.02,
    density: 0.01,
    powder: 0.0,
    viscosity: 0.0,
    dispersion: 150.0,
    conductivity: 0.0,
    heatCapacity: 0.1,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air",
    entity: true,
    behavior: "neutron",
    behaviorParams: {
      interval: 1,
      speed: 1,
      absorbChance: 0.06,
      lifetime: 1000,
      affectedByGravity: false
    }
  },

  {
    name: "Water",
    short: "WATR",
    description_short: "A flowing liquid that freezes to ice and boils to steam, dissolving salt into salt water.",
    state: "liquid",
    color: "#3a78ff",
    colorVar: 0.12,
    density: 0.005,
    powder: 0.0,
    viscosity: 0.22,
    dispersion: 0.0,
    conductivity: 0.55,
    heatCapacity: 14.0,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: null, meltInto: "Air",
    freezeTemp: 1, freezeInto: "Ice",
    boilTemp: 100, boilInto: "Steam",
    condenseTemp: null, condenseInto: "Air",
    // If adjacent to Salt, absorb the salt neighbor and become Salt Water
    script: `
const s = game.getMat('Salt');
if (!s) return;
const saltId = s.id;
let absorbed = false;
canvas.forEachNeighbor(this.x, this.y, (n) => {
  if (absorbed) return;
  if (n.matId === saltId) {
    // remove the salt neighbor (absorbed into solution)
    canvas.set(n.x, n.y, 'Air');
    // convert this water cell into Salt Water
    canvas.set(this.x, this.y, 'Salt Water');
    absorbed = true;
  }
});
`,
    scriptInterval: 8,
    scriptParams: {}
  },
  
  {
    name: "Salt Water",
    short: "SWTR",
    description_short: "A salty solution that can evaporate into steam and leave behind salt.",
    state: "liquid",
    color: "#6193ff",
    colorVar: 0.12,
    density: 0.95,
    powder: 0.0,
    viscosity: 0.22,
    dispersion: 0.0,
    conductivity: 0.55,
    heatCapacity: 14.0,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: null, meltInto: "Air",
    // Behaviors: evaporate into Steam and deposit Salt; release Salt before freezing
    freezeTemp: 1, freezeInto: "Ice",
    boilTemp: 100, boilInto: "Steam",
    condenseTemp: null, condenseInto: "Air",
    script: `
// On boiling: convert to Steam and deposit Salt into a nearby empty cell
const salt = game.getMat('Salt');
if (!salt) return;
const boilT = (this.mat && this.mat.boilTemp) || 100;
if (typeof this.temp === 'number' && this.temp >= boilT) {
  // try to place salt in a nearby empty neighbor (prefer below/around)
  const deltas = [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  for (let i=0;i<deltas.length;i++) {
    const d = deltas[Math.floor(Math.random()*deltas.length)];
    const nx = this.x + d[0], ny = this.y + d[1];
    const info = canvas.get(nx, ny);
    if (!info) continue;
    if (info.matId === 0) { canvas.set(nx, ny, 'Salt'); break; }
  }
  canvas.set(this.x, this.y, 'Steam');
  return;
}
// On freezing: release salt around before turning into Ice
const frT = this.mat && this.mat.freezeTemp;
if (frT != null && typeof this.temp === 'number' && this.temp <= frT) {
  const neigh = [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  for (const d of neigh) {
    const nx = this.x + d[0], ny = this.y + d[1];
    const info = canvas.get(nx, ny);
    if (!info) continue;
    if (info.matId === 0) canvas.set(nx, ny, 'Salt');
  }
  canvas.set(this.x, this.y, 'Ice');
}
`,
    scriptInterval: 6,
    scriptParams: {}
  },

  {
    name: "Ice",
    short: "ICE ",
    description_short: "Cold solid water that melts back into water when warmed.",
    state: "solid",
    color: "#bfe6ff",
    colorVar: 0.08,
    density: 0.92,
    powder: 0.25,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.42,
    heatCapacity: 2.1,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: 0, meltInto: "Water",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Steam",
    short: "STEM",
    description_short: "Hot water vapor that rises and condenses back into water when cooled.",
    state: "gas",
    color: "#cfd9ff",
    colorVar: 0.10,
    density: 0.04,
    powder: 0.0,
    viscosity: 0.0,
    dispersion: 0.95,
    conductivity: 0.005,
    heatCapacity: 3.5,
    heatSource: 0.01,
    decayChance: 0.0,
    decayInto: "Air",
    defaultTemp: 120,
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: 98, condenseInto: "Water"
  },

  {
    name: "Stone",
    short: "STON",
    description_short: "Heavy rocky powder that piles up and can melt into lava at high heat.",
    state: "powder",
    color: "#7b8592",
    colorVar: 0.12,
    density: 2.8,
    powder: 0.05,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.30,
    heatCapacity: 1.9,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    defaultTemp: 20,
    meltTemp: 650, meltInto: "Lava",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Molten Glass",
    short: "MGLS",
    description_short: "Viscous hot glass that cools into solid glass.",
    state: "liquid",
    color: "#ff9e5a",
    colorVar: 0.14,
    density: 2.2,
    powder: 0.0,
    viscosity: 0.62,
    dispersion: 0.0,
    conductivity: 0.34,
    heatCapacity: 2.2,
    heatSource: -0.02,
    decayChance: 0.0,
    decayInto: "Air",
    defaultTemp: 1000,
    meltTemp: null, meltInto: "Air",
    freezeTemp: 800, freezeInto: "Glass",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Glass",
    short: "GLAS",
    description_short: "Hard, brittle solid formed from cooled molten glass.",
    state: "solid",
    color: "#394658",
    colorVar: 0.14,
    density: 2.2,
    powder: 0.0,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.34,
    heatCapacity: 2.2,
    heatSource: -0.02,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: 799, meltInto: "Molten Glass",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Lava",
    short: "LAVA",
    description_short: "Extremely hot liquid rock that heats surroundings and cools into stone.",
    state: "liquid",
    color: "#ff4a2e",
    colorVar: 0.18,
    density: 2.6,
    powder: 0.0,
    viscosity: 0.72,
    dispersion: 0.0,
    conductivity: 0.10,
    heatCapacity: 2.7,
    heatSource: 0.12,
    defaultTemp: 2000,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: null, meltInto: "Air",
    freezeTemp: 600, freezeInto: "Stone",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Smoke",
    short: "SMOK",
    description_short: "Light drifting gas that slowly dissipates into air.",
    state: "gas",
    color: "#2b2b2b",
    colorVar: 0.5,
    density: 0.03,
    powder: 0.0,
    viscosity: 0.0,
    dispersion: 0.98,
    conductivity: 0.20,
    heatCapacity: 1.2,
    heatSource: -0.02,
    decayChance: 0.20,
    decayInto: "Air",
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Salt",
    short: "SALT",
    description_short: "Crystalline powder that can dissolve into water or melt at high temperature.",
    state: "powder",
    color: "#f0e9d8",
    colorVar: 0.06,
    density: 2.16,
    powder: 0.9,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.25,
    heatCapacity: 1.2,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: 801, meltInto: "Lava",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Copper",
    short: "CUPR",
    description_short: "Conductive metal solid that melts into molten copper.",
    state: "solid",
    category: "metal",
    color: "#b87333",
    colorVar: 0.08,
    density: 8.96,
    powder: 0.02,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.9,
    conductive: true,
    heatCapacity: 0.38,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: 1085, meltInto: "Molten Copper",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Oil",
    short: "OIL ",
    description_short: "Thick burnable liquid fuel that ignites at high temperature.",
    state: "liquid",
    color: "#2f2b1f",
    colorVar: 0.06,
    density: 5,
    powder: 0.0,
    viscosity: 0.45,
    dispersion: 0.0,
    conductivity: 0.12,
    heatCapacity: 1.8,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    burnable: true,
    ignitionTemp: 750,
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Gasoline",
    short: "GASL",
    description_short: "Highly flammable liquid fuel that ignites easily.",
    state: "liquid",
    color: "#4b3523",
    colorVar: 0.06,
    density: 5,
    powder: 0.0,
    viscosity: 0.45,
    dispersion: 0.0,
    conductivity: 0.12,
    heatCapacity: 1.8,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    burnable: true,
    ignitionTemp: 280,
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Petroleum",
    short: "PETR",
    description_short: "Volatile fuel-like liquid used as a burnable hydrocarbon.",
    state: "liquid",
    color: "#5b2a88",
    colorVar: 0.2,
    density: 5,
    powder: 0.0,
    viscosity: 0.45,
    dispersion: 0.0,
    conductivity: 0.12,
    heatCapacity: 1.8,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    burnable: true,
    ignitionTemp: 280,
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Diesel",
    short: "DESL",
    description_short: "Dense liquid fuel that is comparatively hard to ignite here.",
    state: "liquid",
    color: "#381e17",
    colorVar: 0.2,
    density: 5,
    powder: 0.0,
    viscosity: 0.45,
    dispersion: 0.0,
    conductivity: 0.12,
    heatCapacity: 1.8,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    burnable: false,
    ignitionTemp: 0,
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Asphalt",
    short: "ASPH",
    description_short: "Very viscous, burnable liquid that flows slowly.",
    state: "liquid",
    color: "#131313",
    colorVar: 0.3,
    density: 5,
    powder: 0.0,
    viscosity: 0.9,
    dispersion: 0.0,
    conductivity: 0.12,
    heatCapacity: 1.8,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    burnable: true,
    ignitionTemp: 200,
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Acid",
    short: "ACID",
    description_short: "Reactive liquid that dissolves nearby materials and heats up as it reacts.",
    state: "liquid",
    category: "liquid",
    color: "#2fffa6",
    colorVar: 0.06,
    density: 1.05,
    powder: 0.0,
    viscosity: 0.45,
    dispersion: 0.0,
    conductivity: 0.12,
    heatCapacity: 1.0,
    heatSource: 0.0,
    decayChance: 0.15,
    decayInto: "steam",
    defaultTemp: 200,
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air",
    // Script: dissolve neighboring particles within 1-cell radius (all non-air)
    script: `
const parts = canvas.find_particles(this.x, this.y, 1, null, 32);
for (const p of parts) {

  if (Math.random() > 0.60) return;
  if (p.x === this.x && p.y === this.y) continue;
  if (!p.matId) continue; // skip air
  if (p.matId === this.mat.id) continue;
  if (p.matId === this.mat.id) continue;
  if (typeof this.temp === 'number' && this.temp > 500) continue;
  canvas.set(p.x, p.y, 'Air');
  this.temp = (this.temp || 20) + Math.min(60, (p.temp || 20) * 0.25 + 50);
}
`,
    scriptInterval: 6,
    scriptParams: {}
  },

  {
    name: "Wood",
    short: "WOOD",
    description_short: "Solid organic material that burns when heated.",
    state: "solid",
    color: "#8b5a2b",
    colorVar: 0.06,
    density: 0.6,
    powder: 0.0,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.14,
    heatCapacity: 1.7,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    burnable: true,
    ignitionTemp: 280,
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Gunpowder",
    short: "GUNP",
    description_short: "Explosive powder that detonates at low temperatures and creates a blast.",
    state: "powder",
    color: "#2e2e2e",
    colorVar: 0.04,
    density: 1.6,
    powder: 0.9,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.12,
    heatCapacity: 1.0,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    explosive: true,
    explodeTemp: 50,
    explosionStrength: 120,
    explosionRadius: 5,
    blastPressure: 500,
    burnable: true,
    ignitionTemp: 2000,
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Grey Goo",
    short: "GGOO",
    description_short: "Self-replicating powder that converts nearby matter into more of itself and heats up.",
    state: "powder",
    color: "#9e9e9e",
    colorVar: 0.06,
    density: 1.2,
    powder: 0.95,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.10,
    heatCapacity: 1.0,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    // Script: 10% chance per tick to convert one neighboring pixel to Grey Goo and raise local temperature.
    script: `
if (Math.random() > 0.60) return;
// pick a random neighbor (exclude self)
let dx = 0, dy = 0;
let attempts = 0;
while ((dx === 0 && dy === 0) && attempts < 6) {
  dx = Math.floor(Math.random()*3)-1;
  dy = Math.floor(Math.random()*3)-1;
  attempts++;
}
const nx = this.x + dx, ny = this.y + dy;
// ensure valid and not the same cell
if (dx === 0 && dy === 0) return;
// inspect neighbor and only convert if it's not air and not already Grey Goo
const info = canvas.get(nx, ny);
if (!info) return;
if (info.matId === 0) return; // ignore air
if (info.matId === this.mat.id) return; // ignore same material
canvas.set(nx, ny, 'Grey Goo');
// heat up the converting cell
this.temp = (this.temp || 20) + 100;
`,
    scriptInterval: 1,
    scriptParams: {}
  },

  {
    name: "Fire",
    short: "FIRE",
    description_short: "Hot, short-lived gas that spreads heat and decays into smoke.",
    state: "gas",
    color: "#ff8a33",
    colorVar: 0.08,
    density: 0.02,
    powder: 0.0,
    viscosity: 0.0,
    dispersion: 0.98,
    conductivity: 0.05,
    heatCapacity: 0.2,
    heatSource: 4.0,
    decayChance: 0.3,
    decayInto: "Smoke",
    defaultTemp: 1200,
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Plutonium",
    short: "PLUT",
    description_short: "Dense nuclear solid that can undergo fission when hit by neutrons.",
    state: "solid",
    category: "nuclear",
    color: "#6b2fff",
    colorVar: 0.06,
    density: 19.8,
    powder: 0.02,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.12,
    heatCapacity: 0.24,
    heatSource: 0.0,
    decayChance: 0.0005,
    decayInto: "Air",
    meltTemp: 640, meltInto: "Molten Plutonium",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air",
    nuclear: true,
    immovable: true,
    fissionOnNeutron: true,
    criticalTemp: 400,
    fissionYield: 3,
    fissionTempMult: 1.6
  },

  {
    name: "Uranium",
    short: "URAN",
    description_short: "Nuclear solid that can fission under neutron hits with moderate yield.",
    state: "solid",
    category: "nuclear",
    color: "#9fbf4a",
    colorVar: 0.06,
    density: 19.1,
    powder: 0.02,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.12,
    heatCapacity: 0.24,
    heatSource: 0.0,
    decayChance: 0.0002,
    decayInto: "Air",
    meltTemp: 1132, meltInto: "Molten Uranium",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air",
    nuclear: true,
    immovable: true,
    fissionOnNeutron: true,
    criticalTemp: 600,
    fissionYield: 2,
    fissionTempMult: 1.25
  },

  {
    name: "Iron",
    short: "IRON",
    description_short: "Conductive metal that can rust when wet and melts into molten iron.",
    state: "solid",
    category: "metal",
    color: "#bfbfbf",
    colorVar: 0.06,
    density: 7.87,
    powder: 0.02,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.8,
    conductive: true,
    heatCapacity: 0.45,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: 1538, meltInto: "Molten Iron",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air",
    script: `
    const water = game.getMat('Water');
    const sw = game.getMat('Salt Water');
    // if (!o2) return;

    let wet = false;
    canvas.forEachNeighbor(this.x, this.y, (n) => {
      if (water && n.matId === water.id) wet = true;
      if (sw && n.matId === sw.id) wet = true;
    });

    if (!wet) return;

    const t = (typeof this.temp === 'number') ? this.temp : 20;
    if (t < -10 || t > 120) return; // very crude slowdown band

    // Salt water rusts faster
    const faster = (sw != null) ? 0.0 : 0.0;
    const p = (sw && wet) ? 0.05 : 0.02;
    if (Math.random() < p) canvas.set(this.x, this.y, 'Rust');
    `,
  },

  {
    name: "Aluminum",
    short: "ALUM",
    description_short: "Light conductive metal that melts into molten aluminum.",
    state: "solid",
    category: "metal",
    color: "#e6e6e6",
    colorVar: 0.05,
    density: 2.70,
    powder: 0.02,
    conductivity: 0.9,
    conductive: true,
    heatCapacity: 0.9,
    meltTemp: 660, meltInto: "Molten Aluminum"
  },

  {
    name: "Gold",
    short: "GOLD",
    description_short: "Dense, very conductive metal that melts into molten gold.",
    state: "solid",
    category: "metal",
    color: "#ffd700",
    colorVar: 0.04,
    density: 19.3,
    powder: 0.01,
    conductivity: 0.95,
    conductive: true,
    heatCapacity: 0.13,
    meltTemp: 1064, meltInto: "Molten Gold"
  },

  {
    name: "Lead",
    short: "LEAD",
    description_short: "Soft, dense metal with moderate conductivity that melts easily.",
    state: "solid",
    category: "metal",
    color: "#6e6666",
    colorVar: 0.03,
    density: 11.34,
    powder: 0.02,
    conductivity: 0.35,
    conductive: true,
    heatCapacity: 0.16,
    meltTemp: 327, meltInto: "Molten Lead"
  },

  {
    name: "Steel",
    short: "STEL",
    description_short: "Strong conductive metal that reflects neutrons and melts into molten steel.",
    state: "solid",
    category: "metal",
    color: "#9aa5a8",
    colorVar: 0.05,
    density: 7.85,
    powder: 0.01,
    conductivity: 0.55,
    heatCapacity: 0.5,
    neutronReflector: true,
    reflectProb: 0.99,
    conductive: true,
    meltTemp: 1370, meltInto: "Molten Steel"
  },

  {
    name: "Gravel",
    short: "GRVL",
    description_short: "Coarse granular powder that falls and melts into lava when heated.",
    state: "powder",
    category: "powder",
    color: "#99957f",
    colorVar: 1.5,
    density: 2.4,
    powder: 0.86,
    conductivity: 0.28,
    heatCapacity: 1.1,
    meltTemp: 1200, meltInto: "Lava"
  },

  {
    name: "Charcoal",
    short: "CHAR",
    description_short: "Carbon-rich powder fuel that burns at moderate heat.",
    state: "powder",
    category: "powder",
    color: "#1f1f1f",
    colorVar: 0.03,
    density: 0.9,
    powder: 0.95,
    conductivity: 0.08,
    heatCapacity: 0.8,
    burnable: true,
    ignitionTemp: 340
  },

  {
    name: "Hydrogen",
    short: "HYDR",
    description_short: "Very light gas that disperses quickly and carries moderate heat.",
    state: "gas",
    category: "gas",
    color: "#ffffff",
    colorVar: 0.02,
    density: 0.02,
    dispersion: 1.0,
    conductivity: 0.08,
    heatCapacity: 1.0
  },

  {
    name: "Helium",
    short: "HELI",
    description_short: "Very light inert gas that disperses quickly.",
    state: "gas",
    category: "gas",
    color: "#f7f7ff",
    colorVar: 0.02,
    density: 0.01,
    dispersion: 1.0,
    conductivity: 0.06,
    heatCapacity: 0.9
  },

  {
    name: "Nitrogen",
    short: "N2  ",
    description_short: "Common atmospheric gas with moderate density and dispersion.",
    state: "gas",
    category: "gas",
    color: "#bfe0ff",
    colorVar: 0.02,
    density: 0.03,
    dispersion: 0.95,
    conductivity: 0.09,
    heatCapacity: 1.0
  },

  {
    name: "Oxygen",
    short: "O2  ",
    description_short: "Reactive atmospheric gas that supports combustion in many systems.",
    state: "gas",
    category: "gas",
    color: "#9fdfff",
    colorVar: 0.02,
    density: 0.03,
    dispersion: 0.95,
    conductivity: 0.1,
    heatCapacity: 1.0
  },

  {
    name: "Coolant",
    short: "COOL",
    description_short: "High heat-capacity liquid used to absorb and move heat, boiling into steam.",
    state: "liquid",
    category: "liquid",
    color: "#00f0ff",
    colorVar: 0.04,
    density: 1.1,
    viscosity: 0.25,
    conductivity: 0.8,
    heatCapacity: 8.0,
    boilTemp: 120, boilInto: "Steam"
  },
  {
    name: "Molten Plutonium",
    short: "MPLT",
    description_short: "Extremely hot, dense liquid nuclear material that decays into stone and solidifies when cooled.",
    state: "liquid",
    category: "nuclear",
    color: "#ff66ff",
    colorVar: 0.08,
    density: 19.5,
    powder: 0.0,
    viscosity: 0.4,
    dispersion: 0.0,
    conductivity: 0.28,
    heatCapacity: 4.0,
    heatSource: 0.0,
    decayChance: 0.02,
    decayInto: "Stone",
    defaultTemp: 1800,
    meltTemp: null, meltInto: "Air",
    freezeTemp: 100, freezeInto: "Stone",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Molten Uranium",
    short: "MURN",
    description_short: "Hot, dense liquid nuclear material that decays into stone and solidifies when cooled.",
    state: "liquid",
    category: "nuclear",
    color: "#ffd64a",
    colorVar: 0.06,
    density: 19.1,
    powder: 0.0,
    viscosity: 0.4,
    dispersion: 0.0,
    conductivity: 0.28,
    heatCapacity: 4.0,
    heatSource: 0.0,
    decayChance: 0.015,
    decayInto: "Stone",
    defaultTemp: 1500,
    meltTemp: null, meltInto: "Air",
    freezeTemp: 100, freezeInto: "Stone",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  // Molten metal variants
  {
    name: "Molten Copper",
    short: "MCOP",
    description_short: "Hot liquid metal that solidifies into copper when cooled.",
    state: "liquid",
    category: "metal",
    color: "#ff8b4a",
    colorVar: 0.06,
    density: 8.9,
    powder: 0.0,
    viscosity: 0.38,
    dispersion: 0.0,
    conductivity: 0.02,
    conductive: true,
    heatCapacity: 2.4,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    defaultTemp: 1200,
    meltTemp: null, meltInto: "Air",
    freezeTemp: 1085, freezeInto: "Copper",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },
  {
    name: "Molten Iron",
    short: "MIRN",
    description_short: "Hot liquid metal that solidifies into iron when cooled.",
    state: "liquid",
    category: "metal",
    color: "#d0d0d0",
    colorVar: 0.04,
    density: 7.9,
    powder: 0.0,
    viscosity: 0.42,
    dispersion: 0.0,
    conductivity: 0.02,
    conductive: true,
    heatCapacity: 2.4,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    defaultTemp: 1650,
    meltTemp: null, meltInto: "Air",
    freezeTemp: 1538, freezeInto: "Iron",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },
  {
    name: "Molten Aluminum",
    short: "MALU",
    description_short: "Hot liquid metal that solidifies into aluminum when cooled.",
    state: "liquid",
    category: "metal",
    color: "#fff8e6",
    colorVar: 0.03,
    density: 2.7,
    powder: 0.0,
    viscosity: 0.28,
    dispersion: 0.0,
    conductivity: 0.02,
    conductive: true,
    heatCapacity: 2.4,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    defaultTemp: 900,
    meltTemp: null, meltInto: "Air",
    freezeTemp: 660, freezeInto: "Aluminum",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },
  {
    name: "Molten Gold",
    short: "MGOL",
    description_short: "Hot liquid metal that solidifies into gold when cooled.",
    state: "liquid",
    category: "metal",
    color: "#ffd84a",
    colorVar: 0.04,
    density: 19.3,
    powder: 0.0,
    viscosity: 0.38,
    dispersion: 0.0,
    conductivity: 0.02,
    conductive: true,
    heatCapacity: 2.4,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    defaultTemp: 1200,
    meltTemp: null, meltInto: "Air",
    freezeTemp: 1064, freezeInto: "Gold",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },
  {
    name: "Molten Lead",
    short: "MLEA",
    description_short: "Hot liquid metal that solidifies into lead when cooled.",
    state: "liquid",
    category: "metal",
    color: "#c0b6b6",
    colorVar: 0.03,
    density: 11.3,
    powder: 0.0,
    viscosity: 0.36,
    dispersion: 0.0,
    conductivity: 0.02,
    conductive: true,
    heatCapacity: 2.4,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    defaultTemp: 600,
    meltTemp: null, meltInto: "Air",
    freezeTemp: 327, freezeInto: "Lead",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },
  {
    name: "Molten Steel",
    short: "MSTL",
    description_short: "Hot liquid metal that solidifies into steel when cooled.",
    state: "liquid",
    category: "metal",
    color: "#bfbfbf",
    colorVar: 0.04,
    density: 7.85,
    powder: 0.0,
    viscosity: 0.45,
    dispersion: 0.0,
    conductivity: 0.02,
    conductive: true,
    heatCapacity: 2.4,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    defaultTemp: 1600,
    meltTemp: null, meltInto: "Air",
    freezeTemp: 1370, freezeInto: "Steel",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Emitter",
    short: "EMIT",
    description_short: "Special solid entity that exists as an emitter object rather than a normal particle.",
    state: "solid",
    category: "special",
    color: "#ff00aa",
    colorVar: 0.06,
    density: 0.0,
    powder: 0.0,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.0,
    heatCapacity: 0.1,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air",
    entity: true,
    behavior: "emitter",
    behaviorParams: { lifetime: 0 }
  },

  {
    name: "Void",
    short: "VOID",
    description_short: "Special solid that deletes neighboring non-void cells and entities on contact.",
    state: "solid",
    category: "special",
    color: "#2b003f",
    colorVar: 0.3,
    density: 0.0,
    powder: 0.0,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.0,
    heatCapacity: 0.1,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air",
    
    script: `
// remove neighboring grid cells and entities but never remove other Void cells (or itself)
const neigh = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
for (const d of neigh) {
  const nx = this.x + d[0], ny = this.y + d[1];
  const info = canvas.get(nx, ny);
  if (!info) continue;
  // Skip deleting other Void cells to avoid mutual/self-deletion
  if (info.matId === this.mat.id) continue;
  if (info.matId !== 0) canvas.set(nx, ny, 'Air');
  // also request entity removal at that cell if API available
  try { if (typeof game.removeEntitiesAt === 'function') game.removeEntitiesAt(nx, ny); } catch (e) { /* ignore */ }
}
`,
    scriptInterval: 1,

  },

  {
    name: "Deuterium",
    short: "DEUT",
    description_short: "Nuclear liquid that can absorb neutrons for heat or fission into more neutrons via script.",
    state: "liquid",
    category: "nuclear",
    color: "#2d4097",
    colorVar: 0.18,
    density: 2.6,
    powder: 0.0,
    viscosity: 0.72,
    dispersion: 0.0,
    conductivity: 0.10,
    heatCapacity: 2.7,
    heatSource: 0.0,
    defaultTemp: 100,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air",
    // Deuterium handled by a script when a neutron interacts.
    // Script will return an object indicating action: { absorbNeutron: true } or { fission: N, consumeSelf: true }
    script: `
// params: { absorbChance: 0.3, absorbHeat: 50, fissionYield: 3 }
const p = params && params.absorbChance != null ? Number(params.absorbChance) : 0.3;
if (Math.random() < p) {
  // absorb: heat the cell and signal to caller to remove the neutron
  this.temp = (this.temp || 0) + (params && params.absorbHeat != null ? Number(params.absorbHeat) : 50);
  return { absorbNeutron: true };
} else {
  // fission: indicate spawn count and that this cell should be consumed
  return { fission: (params && params.fissionYield != null) ? Number(params.fissionYield) : 3, consumeSelf: true };
`,
    scriptInterval: 1,
    scriptParams: { absorbChance: 0.3, absorbHeat: 50, fissionYield: 3 }
  },
  // --- Tools (paint to apply an instantaneous effect, then clear) ---
  {
    name: "Tool: Heat",
    short: "HEAT",
    description_short: "Instant tool that adds heat within a radius and then clears.",
    state: "solid",
    category: "tool",
    color: "#ffcc66",
    colorVar: 0.02,
    density: 0.0,
    powder: 0.0,
    conductivity: 0.0,
    heatCapacity: 0.1,
    isTool: true,
    toolType: "heat",
    toolRadius: 3,
    toolIntensity: 1.0
  },
  {
    name: "Tool: Cool",
    short: "COOL",
    description_short: "Instant tool that removes heat within a radius and then clears.",
    state: "solid",
    category: "tool",
    color: "#66ddff",
    colorVar: 0.02,
    density: 0.0,
    powder: 0.0,
    conductivity: 0.0,
    heatCapacity: 0.1,
    isTool: true,
    toolType: "cool",
    toolRadius: 3,
    toolIntensity: 1.0
  },
  {
    name: "Tool: Mixer",
    short: "MIX ",
    description_short: "Instant tool that mixes materials within a radius and then clears.",
    state: "solid",
    category: "tool",
    color: "#c6a0ff",
    colorVar: 0.02,
    density: 0.0,
    powder: 0.0,
    conductivity: 0.0,
    heatCapacity: 0.1,
    isTool: true,
    toolType: "mixer",
    toolRadius: 3,
    toolIntensity: 1.0
  },
  {
    name: "Tool: Move",
    short: "MOVE",
    description_short: "Instant tool that pushes or relocates particles within a radius and then clears.",
    state: "solid",
    category: "tool",
    color: "#a0ffd6",
    colorVar: 0.02,
    density: 0.0,
    powder: 0.0,
    conductivity: 0.0,
    heatCapacity: 0.1,
    isTool: true,
    toolType: "move",
    toolRadius: 3,
    toolIntensity: 1.0
  },
  {
  name: "Dirt",
  short: "DIRT",
  description_short: "Loose earth powder that falls and can melt into lava at high heat.",
  state: "powder",
  color: "#6b4f2a",
  colorVar: 0.10,
  density: 1.6,
  powder: 0.85,
  viscosity: 0.0,
  dispersion: 0.0,
  conductivity: 0.10,
  heatCapacity: 1.2,
  heatSource: 0.0,
  decayChance: 0.0,
  decayInto: "Air",
  meltTemp: 1200, meltInto: "Lava",
  freezeTemp: null, freezeInto: "Air",
  boilTemp: null, boilInto: "Air",
  condenseTemp: null, condenseInto: "Air"
},

{
  name: "Mud",
  short: "MUD ",
  description_short: "Thick wet slurry that flows slowly, can boil into steam, and can harden when frozen.",
  state: "liquid",
  color: "#5a4326",
  colorVar: 0.10,
  density: 1.4,
  powder: 0.0,
  viscosity: 0.55,
  dispersion: 0.0,
  conductivity: 0.18,
  heatCapacity: 2.0,
  heatSource: 0.0,
  decayChance: 0.0,
  decayInto: "Air",
  meltTemp: null, meltInto: "Air",
  freezeTemp: 0, freezeInto: "Stone",
  boilTemp: 100, boilInto: "Steam",
  condenseTemp: null, condenseInto: "Air"
},

{
  name: "Snow",
  short: "SNOW",
  description_short: "Light powder that melts into water at 0°C.",
  state: "powder",
  color: "#ffffff",
  colorVar: 0.06,
  density: 0.35,
  powder: 0.95,
  viscosity: 0.0,
  dispersion: 0.0,
  conductivity: 0.08,
  heatCapacity: 1.6,
  heatSource: 0.0,
  decayChance: 0.0,
  decayInto: "Air",
  meltTemp: 0, meltInto: "Water",
  freezeTemp: null, freezeInto: "Air",
  boilTemp: null, boilInto: "Air",
  condenseTemp: null, condenseInto: "Air"
},

{
  name: "Ash",
  short: "ASH ",
  description_short: "Fine powder residue that disperses slightly and melts into lava when heated.",
  state: "powder",
  color: "#6a6a6a",
  colorVar: 0.10,
  density: 0.6,
  powder: 0.95,
  viscosity: 0.0,
  dispersion: 0.15,
  conductivity: 0.05,
  heatCapacity: 0.9,
  heatSource: 0.0,
  decayChance: 0.0,
  decayInto: "Air",
  meltTemp: 1100, meltInto: "Lava",
  freezeTemp: null, freezeInto: "Air",
  boilTemp: null, boilInto: "Air",
  condenseTemp: null, condenseInto: "Air"
},

{
  name: "Concrete",
  short: "CONC",
  description_short: "Rigid building solid that melts into lava at high heat.",
  state: "solid",
  color: "#9aa0a6",
  colorVar: 0.06,
  density: 2.3,
  powder: 0.0,
  viscosity: 0.0,
  dispersion: 0.0,
  conductivity: 0.25,
  heatCapacity: 1.1,
  heatSource: 0.0,
  decayChance: 0.0,
  decayInto: "Air",
  meltTemp: 1400, meltInto: "Lava",
  freezeTemp: null, freezeInto: "Air",
  boilTemp: null, boilInto: "Air",
  condenseTemp: null, condenseInto: "Air"
},

{
  name: "Rubber",
  short: "RUBR",
  description_short: "Flexible burnable solid that can melt into oil.",
  state: "solid",
  color: "#1b1b1b",
  colorVar: 0.03,
  density: 1.1,
  powder: 0.0,
  viscosity: 0.0,
  dispersion: 0.0,
  conductivity: 0.05,
  heatCapacity: 1.6,
  heatSource: 0.0,
  decayChance: 0.0,
  decayInto: "Air",
  burnable: true,
  ignitionTemp: 420,
  meltTemp: 180, meltInto: "Oil",
  freezeTemp: null, freezeInto: "Air",
  boilTemp: null, boilInto: "Air",
  condenseTemp: null, condenseInto: "Air"
},

{
  name: "Wax",
  short: "WAX ",
  description_short: "Soft burnable solid that melts into liquid wax.",
  state: "solid",
  color: "#f3e6a2",
  colorVar: 0.05,
  density: 0.9,
  powder: 0.0,
  viscosity: 0.0,
  dispersion: 0.0,
  conductivity: 0.06,
  heatCapacity: 2.2,
  heatSource: 0.0,
  decayChance: 0.0,
  decayInto: "Air",
  burnable: true,
  ignitionTemp: 260,
  meltTemp: 100, meltInto: "Liquid Wax",
  freezeTemp: null, freezeInto: "Air",
  boilTemp: null, boilInto: "Air",
  condenseTemp: null, condenseInto: "Air"
},

{
  name: "Liquid Wax",
  short: "LWAX",
  description_short: "Low-viscosity burnable liquid that cools back into wax.",
  state: "liquid",
  color: "#f3e6a2",
  colorVar: 0.05,
  density: 0.9,
  powder: 0.0,
  viscosity: 0.01,
  dispersion: 0.0,
  conductivity: 0.06,
  heatCapacity: 2.2,
  heatSource: 0.0,
  decayChance: 0.0,
  decayInto: "Air",
  burnable: true,
  ignitionTemp: 260,
  meltTemp: null, meltInto: "Air",
  freezeTemp: 80, freezeInto: "Wax",
  boilTemp: null, boilInto: "Air",
  condenseTemp: null, condenseInto: "Air"
},

{
  name: "Methane",
  short: "CH4 ",
  description_short: "Light flammable gas that disperses quickly.",
  state: "gas",
  color: "#e8fff2",
  colorVar: 0.03,
  density: 0.01,
  powder: 0.0,
  viscosity: 0.0,
  dispersion: 1.0,
  conductivity: 0.06,
  heatCapacity: 1.0,
  heatSource: 0.0,
  decayChance: 0.0,
  decayInto: "Air",
  burnable: true,
  ignitionTemp: 540,
  meltTemp: null, meltInto: "Air",
  freezeTemp: null, freezeInto: "Air",
  boilTemp: null, boilInto: "Air",
  condenseTemp: null, condenseInto: "Air"
},

{
  name: "Carbon Dioxide",
  short: "CO2 ",
  description_short: "Heavy gas that can freeze into a dry-ice stand-in at low temperature.",
  state: "gas",
  color: "#d6d6d6",
  colorVar: 0.03,
  density: 0.06,
  powder: 0.0,
  viscosity: 0.0,
  dispersion: 0.75,
  conductivity: 0.07,
  heatCapacity: 0.9,
  heatSource: -0.01,
  decayChance: 0.0,
  decayInto: "Air",
  meltTemp: null, meltInto: "Air",
  freezeTemp: -78, freezeInto: "Ice", // cheap "dry ice" stand-in
  boilTemp: null, boilInto: "Air",
  condenseTemp: null, condenseInto: "Air"
},

{
  name: "Mercury",
  short: "MERC",
  description_short: "Dense conductive liquid metal that can freeze into solid mercury.",
  state: "liquid",
  color: "#b7bcc6",
  colorVar: 0.05,
  density: 13.5,
  powder: 0.0,
  viscosity: 0.12,
  dispersion: 0.0,
  conductivity: 0.85,
  heatCapacity: 0.14,
  heatSource: 0.0,
  decayChance: 0.0,
  decayInto: "Air",
  meltTemp: -39, meltInto: "Mercury",
  freezeTemp: -39, freezeInto: "Solid Mercury", // stand-in "solid mercury" if you don’t add a new solid
  boilTemp: null, boilInto: "Air",
  condenseTemp: 350, condenseInto: "Mercury"
},

{
  name: "Solid Mercury",
  short: "SMRC",
  description_short: "Frozen mercury solid that melts back and boils into steam at high heat.",
  state: "solid",
  color: "#b7bcc6",
  colorVar: 0.2,
  density: 13.5,
  powder: 0.0,
  viscosity: 0.12,
  dispersion: 0.0,
  conductivity: 0.85,
  heatCapacity: 0.14,
  heatSource: 0.0,
  decayChance: 0.0,
  decayInto: "Air",
  meltTemp: -39, meltInto: "Mercury",
  freezeTemp: -39, freezeInto: "Iron", // stand-in "solid mercury" if you don’t add a new solid
  boilTemp: 357, boilInto: "Steam",
  condenseTemp: 350, condenseInto: "Mercury"
},

{
  name: "Obsidian",
  short: "OBSD",
  description_short: "Hard immovable volcanic glass that forms from lava-like heat and resists movement.",
  state: "solid",
  color: "#1a1420",
  colorVar: 0.06,
  density: 2.4,
  powder: 0.0,
  viscosity: 0.0,
  dispersion: 0.0,
  conductivity: 0.20,
  heatCapacity: 1.0,
  heatSource: 0.0,
  decayChance: 0.0,
  decayInto: "Air",
  meltTemp: 900, meltInto: "Lava",
  freezeTemp: null, freezeInto: "Air",
  boilTemp: null, boilInto: "Air",
  condenseTemp: null, condenseInto: "Air",
  immovable: true
},
];

const ADDITIONAL_MATERIALS = [

  {
    name: "Ceramic",
    short: "CRMC",
    description_short: "Hard heat-resistant solid that survives high temperatures before melting.",
    state: "solid",
    category: "solid",
    color: "#d9d6cf",
    colorVar: 0.05,
    density: 2.6,
    powder: 0.02,
    conductivity: 0.12,
    heatCapacity: 1.2,
    heatSource: 0.0,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: 1800, meltInto: "Lava",
    scriptInterval: 8
  },

  // ---------- Powders / terrain ----------
  {
    name: "Clay",
    short: "CLAY",
    description_short: "Fine powder that can mix with water to form clay slurry.",
    state: "powder",
    category: "powder",
    color: "#9b6a55",
    colorVar: 0.10,
    density: 1.7,
    powder: 0.9,
    conductivity: 0.12,
    heatCapacity: 1.3,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: 1050, meltInto: "Lava",
    script: `
const water = game.getMat('Water');
if (!water) return;
let mixed = false;
canvas.forEachNeighbor(this.x, this.y, (n) => {
  if (mixed) return;
  if (n.matId === water.id) {
    // consume the water neighbor -> make slurry here
    canvas.set(n.x, n.y, 'Air');
    canvas.set(this.x, this.y, 'Clay Slurry');
    mixed = true;
  }
});
`,
    scriptInterval: 10
  },

  {
    name: "Silt",
    short: "SILT",
    description_short: "Fine powder sediment that behaves like soft terrain and melts to lava when heated.",
    state: "powder",
    category: "powder",
    color: "#8a7a5a",
    colorVar: 0.12,
    density: 1.3,
    powder: 0.92,
    conductivity: 0.10,
    heatCapacity: 1.1,
    meltTemp: 1200, meltInto: "Lava"
  },

  {
    name: "Peat",
    short: "PEAT",
    description_short: "Organic powder fuel that burns and represents decomposed plant matter.",
    state: "powder",
    category: "organic",
    color: "#3b2a1f",
    colorVar: 0.1,
    density: 0.03,
    powder: 0.95,
    conductivity: 0.06,
    heatCapacity: 1.3,
    burnable: true,
    ignitionTemp: 320,
    decayChance: 0.0
  },

  // ---------- Liquids ----------
  {
    name: "Clay Slurry",
    short: "SLRY",
    description_short: "Wet clay liquid that can dry into brick when warm and exposed to air.",
    state: "liquid",
    category: "liquid",
    color: "#7f5a49",
    colorVar: 0.10,
    density: 1.35,
    viscosity: 0.65,
    conductivity: 0.16,
    heatCapacity: 2.2,
    decayChance: 0.0,
    decayInto: "Air",
    freezeTemp: -1, freezeInto: "Stone",
    boilTemp: 100, boilInto: "Steam",
    // Drying: if warm-ish and next to Air, turn into Brick
    script: `
if (typeof this.temp !== 'number') this.temp = (this.temp || 20);
if (this.temp < 55) return;

let hasAir = false;
canvas.forEachNeighbor(this.x, this.y, (n) => {
  if (n.matId === 0) hasAir = true;
});
if (!hasAir) return;

// chance-based drying
if (Math.random() < 0.20) canvas.set(this.x, this.y, 'Brick');
`,
    scriptInterval: 8
  },

  {
    name: "Wet Concrete",
    short: "WCON",
    description_short: "Liquid concrete mix that hardens into concrete over time.",
    state: "liquid",
    category: "liquid",
    color: "#8f8f8f",
    colorVar: 0.06,
    density: 2.1,
    viscosity: 0.85,
    conductivity: 0.22,
    heatCapacity: 1.4,
    decayChance: 0.0,
    // Hardens over time; faster if warm and exposed to air
    script: `
let airAdj = false;
canvas.forEachNeighbor(this.x, this.y, (n) => { if (n.matId === 0) airAdj = true; });
const t = (typeof this.temp === 'number') ? this.temp : 20;
const base = airAdj ? 0.06 : 0.02;
const bonus = (t >= 40) ? 0.04 : 0.0;
if (Math.random() < (base + bonus)) canvas.set(this.x, this.y, 'Concrete');
`,
    scriptInterval: 10
  },

  {
    name: "Brine",
    short: "BRIN",
    description_short: "Salty liquid that can convert into salt water when contacting salt.",
    state: "liquid",
    category: "liquid",
    color: "#6aa0ff",
    colorVar: 0.10,
    density: 1.05,
    viscosity: 0.28,
    conductivity: 0.60,
    heatCapacity: 10.0,
    boilTemp: 100, boilInto: "Steam",
    freezeTemp: -5, freezeInto: "Ice",
    // If adjacent to Salt, become Salt Water (compatible with your existing system)
    script: `
const salt = game.getMat('Salt');
if (!salt) return;
let hit = false;
canvas.forEachNeighbor(this.x, this.y, (n) => {
  if (hit) return;
  if (n.matId === salt.id) {
    canvas.set(n.x, n.y, 'Air');
    canvas.set(this.x, this.y, 'Salt Water');
    hit = true;
  }
});
`,
    scriptInterval: 10
  },

  // ---------- Gases ----------
  {
    name: "Fog",
    short: "FOG ",
    description_short: "Cool damp gas that drifts and can condense into water.",
    state: "gas",
    category: "gas",
    color: "#d9d9e6",
    colorVar: 0.08,
    density: 0.06,
    dispersion: 0.80,
    conductivity: 0.08,
    heatCapacity: 1.2,
    heatSource: -0.01,
    decayChance: 0.04,
    decayInto: "Air",
    // If cold enough, condense into Water (simple stand-in)
    condenseTemp: 10, condenseInto: "Water"
  },

  {
    name: "Chlorine",
    short: "CL2 ",
    description_short: "Heavy gas that lingers and can be used for chemical interactions.",
    state: "gas",
    category: "gas",
    color: "#d8ff6a",
    colorVar: 0.05,
    density: 0.09,
    dispersion: 0.85,
    conductivity: 0.07,
    heatCapacity: 1.0,
    decayChance: 0.0
  },

  // ---------- Solids / building ----------
  {
    name: "Brick",
    short: "BRIK",
    description_short: "Immovable building solid formed from dried clay slurry.",
    state: "solid",
    category: "solid",
    color: "#a0422c",
    colorVar: 0.08,
    density: 2.0,
    powder: 0.02,
    conductivity: 0.18,
    heatCapacity: 1.1,
    meltTemp: 1200, meltInto: "Lava",
    immovable: true
  },

  {
    name: "Graphite",
    short: "GRPH",
    description_short: "Carbon solid that reflects neutrons and can burn at very high heat.",
    state: "solid",
    category: "nuclear",
    color: "#2a2a2a",
    colorVar: 0.04,
    density: 2.1,
    powder: 0.02,
    conductivity: 0.45,
    heatCapacity: 0.9,
    neutronReflector: true,
    reflectProb: 0.65,
    burnable: true,
    ignitionTemp: 900
  },

  {
    name: "Boron",
    short: "BORN",
    description_short: "Neutron-absorbing solid used to capture neutrons in nuclear setups.",
    state: "solid",
    category: "nuclear",
    color: "#4a7a2a",
    colorVar: 0.05,
    density: 2.3,
    powder: 0.02,
    conductivity: 0.18,
    heatCapacity: 0.8,
    // If you have neutron entities, treat Boron as an absorber with a script hook
    script: `
/*
If your neutron behavior checks neighbor materials for "absorbNeutron",
you can standardize on returning { absorbNeutron: true }.
Otherwise this script is inert.
*/
return { absorbNeutron: true };
`,
    scriptInterval: 1
  },

  // ---------- Metals / corrosion ----------
  {
    name: "Rust",
    short: "RUST",
    description_short: "Flaky oxidized iron solid/powder that forms from corroding iron.",
    state: "solid",
    category: "metal",
    color: "#b04a2a",
    colorVar: 0.10,
    density: 3.4,
    powder: 0.95,
    conductivity: 0.15,
    heatCapacity: 0.7,
    meltTemp: 1400, meltInto: "Molten Iron",
  },
  // ---------- Biology ----------
  {
    name: "Algae",
    short: "ALGA",
    description_short: "Organic powder that slowly grows in warm water.",
    state: "powder",
    category: "organic",
    color: "#2ea84a",
    colorVar: 0.12,
    density: 0.01,
    powder: 0.9,
    conductivity: 0.08,
    heatCapacity: 1.1,
    // Slowly grows into adjacent Water if warm
    script: `
const water = game.getMat('Water');
if (!water) return;
const t = (typeof this.temp === 'number') ? this.temp : 20;
if (t < 30) return;
if (t > 50) return;

if (Math.random() > 0.3) return;

const neigh = [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
const d = neigh[Math.floor(Math.random()*neigh.length)];
const nx = this.x + d[0], ny = this.y + d[1];
const info = canvas.get(nx, ny);
if (!info) return;
if (info.matId === water.id) canvas.set(nx, ny, 'Algae');
`,
    scriptInterval: 20
  },

  {
    name: "Plant",
    short: "PLNT",
    description_short: "Organic solid that grows when near water and can die back when dry.",
    state: "solid",
    category: "organic",
    color: "#2f7a2f",
    colorVar: 0.10,
    density: 0.55,
    powder: 0.0,
    conductivity: 0.10,
    heatCapacity: 1.3,
    burnable: true,
    ignitionTemp: 260,
    script: `
// Grow when water is adjacent; die into Peat when not touching water.
// Growth only occurs into Air cells that are adjacent to a non-air material.
const water = game.getMat('Water');
const peat = game.getMat('Peat');
if (!water) return;

let touchingWater = false;
canvas.forEachNeighbor(this.x, this.y, (n) => {
  if (n.matId === water.id) touchingWater = true;
});

if (touchingWater) {
  // Try a few random neighbor air cells and grow into the first valid one
  const deltas = [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  for (let attempts = 0; attempts < 3; attempts++) {
    const d = deltas[Math.floor(Math.random()*deltas.length)];
    const nx = this.x + d[0], ny = this.y + d[1];
    const info = canvas.get(nx, ny);
    if (!info) continue;
    // must be air to grow into
    if (info.matId !== 0) continue;
    // ensure target air cell is adjacent to some non-air material
    let connected = false;
    for (const dd of deltas) {
      const adj = canvas.get(nx + dd[0], ny + dd[1]);
      if (!adj) continue;
      if (adj.matId !== 0) { connected = true; break; }
    }
    if (!connected) continue;
    // growth probability
    if (Math.random() < 0.25) {
      canvas.set(nx, ny, 'Plant');
      break;
    }
  }
} else {
  if (peat && Math.random() < 0.002) canvas.set(this.x, this.y, 'Air');
}
`,
    scriptInterval: 8,
    scriptParams: {}
  },

  {
    name: "Plasma",
    short: "PLSM",
    description_short: "Extremely hot gas that behaves like energetic fire and decays into fire.",
    state: "gas",
    category: "gas",
    color: "#ffd6ff",
    colorVar: 0.10,
    density: 0.005,
    dispersion: 1.0,
    conductivity: 0.02,
    heatCapacity: 0.2,
    heatSource: 6.0,
    decayChance: 0.35,
    decayInto: "Fire",
    defaultTemp: 5000
  },

    {
    name: "Rich Soil",
    short: "RSOL",
    description_short: "Nutrient-rich earth powder that supports plant growth.",
    state: "powder",
    category: "organic",
    color: "#3a2a16",
    colorVar: 0.10,
    density: 1.0,
    powder: 0.88,
    conductivity: 0.10,
    heatCapacity: 1.3,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: 1200, meltInto: "Lava",
    scriptInterval: 20
  },

  // ---------- Plants ----------
  {
    name: "Grass",
    short: "GRAS",
    description_short: "Organic powder that spreads on damp dirt and dies near hazards.",
    state: "powder", // “solid-lite” behavior
    category: "organic",
    color: "#2db84a",
    colorVar: 0.14,
    density: 0.45,
    powder: 0.85,
    conductivity: 0.06,
    heatCapacity: 1.1,
    burnable: true,
    ignitionTemp: 220,
    decayChance: 0.0,
    decayInto: "Air",
    // Spreads on Dirt/Rich Soil if adjacent to Water; dies near Lava/Acid
    script: `
const dirt = game.getMat('Dirt');
const rsoil = game.getMat('Rich Soil');
const water = game.getMat('Water');
const mud = game.getMat('Mud');
const lava = game.getMat('Lava');
const acid = game.getMat('Acid');
const smoke = game.getMat('Smoke');

let damp = false;
let hazard = false;

canvas.forEachNeighbor(this.x, this.y, (n) => {
  if (!damp) {
    if (water && n.matId === water.id) damp = true;
    if (mud && n.matId === mud.id) damp = true;
  }
  if (!hazard) {
    if (lava && n.matId === lava.id) hazard = true;
    if (acid && n.matId === acid.id) hazard = true;
  }
});

if (hazard) {
  // scorch
  if (smoke && Math.random() < 0.30) canvas.set(this.x, this.y, 'Smoke');
  else canvas.set(this.x, this.y, 'Air');
  return;
}

if (!damp) {
  // without water, grass can thin out
  if (Math.random() < 0.01) canvas.set(this.x, this.y, 'Air');
  return;
}

// spread
if (Math.random() > 0.12) return;
const neigh = [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
const d = neigh[Math.floor(Math.random()*neigh.length)];
const nx = this.x + d[0], ny = this.y + d[1];
const info = canvas.get(nx, ny);
if (!info) return;
if (dirt && info.matId === dirt.id) canvas.set(nx, ny, 'Grass');
if (rsoil && info.matId === rsoil.id) canvas.set(nx, ny, 'Grass');
`,
    scriptInterval: 18
  },

  {
    name: "Moss",
    short: "MOSS",
    description_short: "Organic powder that spreads on damp stone or concrete surfaces.",
    state: "powder",
    category: "organic",
    color: "#1f8a3a",
    colorVar: 0.14,
    density: 0.55,
    powder: 0.92,
    conductivity: 0.06,
    heatCapacity: 1.1,
    burnable: true,
    ignitionTemp: 240,
    decayChance: 0.0,
    // Spreads on Stone/Concrete if damp
    script: `
const stone = game.getMat('Stone');
const conc = game.getMat('Concrete');
const water = game.getMat('Water');
const mud = game.getMat('Mud');
const steam = game.getMat('Steam');
const fog = game.getMat('Fog');

let damp = false;
canvas.forEachNeighbor(this.x, this.y, (n) => {
  if (damp) return;
  if (water && n.matId === water.id) damp = true;
  if (mud && n.matId === mud.id) damp = true;
  if (steam && n.matId === steam.id) damp = true;
  if (fog && n.matId === fog.id) damp = true;
});
if (!damp) {
  if (Math.random() < 0.01) canvas.set(this.x, this.y, 'Air');
  return;
}

if (Math.random() > 0.10) return;
const neigh = [[0,1],[1,0],[-1,0],[0,-1]];
const d = neigh[Math.floor(Math.random()*neigh.length)];
const nx = this.x + d[0], ny = this.y + d[1];
const info = canvas.get(nx, ny);
if (!info) return;

if (stone && info.matId === stone.id) canvas.set(nx, ny, 'Moss');
if (conc && info.matId === conc.id) canvas.set(nx, ny, 'Moss');
`,
    scriptInterval: 22
  },

  // ---------- Sap / resin ----------
  {
    name: "Sap",
    short: "SAP ",
    description_short: "Sticky burnable liquid that can harden into resin when cooled.",
    state: "liquid",
    category: "organic",
    color: "#caa44a",
    colorVar: 0.10,
    density: 1.05,
    viscosity: 0.78,
    conductivity: 0.10,
    heatCapacity: 1.8,
    burnable: true,
    ignitionTemp: 260,
    decayChance: 0.0,
    decayInto: "Air",
    // Hardens into Resin when cooled
    freezeTemp: 18, freezeInto: "Resin",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air"
  },

  {
    name: "Resin",
    short: "RSIN",
    description_short: "Hardened sap solid that can melt back into sap and burns when heated.",
    state: "solid",
    category: "organic",
    color: "#b89035",
    colorVar: 0.08,
    density: 1.1,
    powder: 0.06, // brittle-ish
    conductivity: 0.08,
    heatCapacity: 1.4,
    burnable: true,
    ignitionTemp: 300,
    decayChance: 0.0,
    decayInto: "Air",
    meltTemp: 80, meltInto: "Sap",
    immovable: false
  },

  // ---------- Fungi chain ----------
  {
    name: "Mold",
    short: "MOLD",
    description_short: "Fungal powder that spreads in humid areas and sheds spores.",
    state: "powder",
    category: "organic",
    color: "#5f8f5a",
    colorVar: 0.18,
    density: 0.50,
    powder: 0.95,
    conductivity: 0.05,
    heatCapacity: 1.0,
    decayChance: 0.0,
    decayInto: "Air",
    // In humid areas, spreads on Wood (and optionally other organics if you add them),
    // and occasionally converts into Spores (gas).
    script: `
const wood = game.getMat('Wood');
const water = game.getMat('Water');
const mud = game.getMat('Mud');
const steam = game.getMat('Steam');
const fog = game.getMat('Fog');
const acid = game.getMat('Acid');
const lava = game.getMat('Lava');

let humid = false;
let hazard = false;

canvas.forEachNeighbor(this.x, this.y, (n) => {
  if (!humid) {
    if (water && n.matId === water.id) humid = true;
    if (mud && n.matId === mud.id) humid = true;
    if (steam && n.matId === steam.id) humid = true;
    if (fog && n.matId === fog.id) humid = true;
  }
  if (!hazard) {
    if (acid && n.matId === acid.id) hazard = true;
    if (lava && n.matId === lava.id) hazard = true;
  }
});

if (hazard) { canvas.set(this.x, this.y, 'Air'); return; }

if (humid) {
  // spread to wood
  if (Math.random() < 0.10 && wood) {
    const neigh = [[0,1],[1,0],[-1,0],[0,-1]];
    const d = neigh[Math.floor(Math.random()*neigh.length)];
    const nx = this.x + d[0], ny = this.y + d[1];
    const info = canvas.get(nx, ny);
    if (info && info.matId === wood.id) canvas.set(nx, ny, 'Mold');
  }
  // shed spores sometimes
  if (Math.random() < 0.03) canvas.set(this.x, this.y, 'Spores');
} else {
  // dry -> die back
  if (Math.random() < 0.02) canvas.set(this.x, this.y, 'Air');
}
`,
    scriptInterval: 16
  },

  {
    name: "Spores",
    short: "SPOR",
    description_short: "Airborne fungal gas that seeds mold onto nearby organic materials.",
    state: "gas",
    category: "organic",
    color: "#a8d9a0",
    colorVar: 0.20,
    density: 0.02,
    dispersion: 0.98,
    conductivity: 0.05,
    heatCapacity: 0.9,
    heatSource: 0.0,
    decayChance: 0.12,
    decayInto: "Air",
    // Seed Mold on contact with organics (Wood / Grass / Moss / Rich Soil / Dirt)
    script: `
const wood = game.getMat('Wood');
const grass = game.getMat('Grass');
const moss = game.getMat('Moss');
const dirt = game.getMat('Dirt');
const rsoil = game.getMat('Rich Soil');

let seeded = false;
canvas.forEachNeighbor(this.x, this.y, (n) => {
  if (seeded) return;
  if (!n.matId) return;
  if (wood && n.matId === wood.id) { canvas.set(n.x, n.y, 'Mold'); seeded = true; }
  else if (grass && n.matId === grass.id) { canvas.set(n.x, n.y, 'Mold'); seeded = true; }
  else if (moss && n.matId === moss.id) { canvas.set(n.x, n.y, 'Mold'); seeded = true; }
  else if (rsoil && n.matId === rsoil.id) { canvas.set(n.x, n.y, 'Mold'); seeded = true; }
  else if (dirt && n.matId === dirt.id) { canvas.set(n.x, n.y, 'Mold'); seeded = true; }
});

if (seeded) {
  // after seeding, clear this spore cell
  canvas.set(this.x, this.y, 'Air');
}
`,
    scriptInterval: 6
  },

  {
    name: "Mycelium",
    short: "MYCL",
    description_short: "Underground fungal network powder that spreads through soil under controlled rules.",
    state: "powder",
    category: "organic",
    color: "#d6d1c2",
    colorVar: 0.10,
    density: 1.0,
    powder: 0.05,
    conductivity: 0.08,
    heatCapacity: 1.2,
    burnable: true,
    ignitionTemp: 260,
    decayChance: 0.0,
    script: `
// Spread into nearby soil under controlled rules:
// - Target soil cells: Dirt or Rich Soil.
// - Only spread into a soil cell that has exactly 1 Mycelium neighbor.
// - Chance per tick to convert such a soil cell: 0.05.
// - Do not spread into Rich Soil that has a neighbor which itself has a neighbor that is Air
//   (prevents spreading near the surface).
const dirt = game.getMat('Dirt');
const rsoil = game.getMat('Rich Soil');
const myc = game.getMat('Mycelium');
if (!myc) return;

// If this mycelium cell is overcrowded (more than one neighboring Mycelium), die back to Dirt
{
  const deltas_check = [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  let neighCount = 0;
  for (const dd of deltas_check) {
    const cx = this.x + dd[0], cy = this.y + dd[1];
    const cinfo = canvas.get(cx, cy);
    if (!cinfo) continue;
    if (cinfo.matId === myc.id) neighCount++;
    if (neighCount > 1) break;
  }
  if (neighCount > 1) {
    const dirtMat = game.getMat('Dirt');
    if (dirtMat) canvas.set(this.x, this.y, 'Dirt');
    else canvas.set(this.x, this.y, 'Air');
    return;
  }
}

const deltas = [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];

for (const d of deltas) {
  const nx = this.x + d[0], ny = this.y + d[1];
  const info = canvas.get(nx, ny);
  if (!info) continue;
  const isDirt = dirt && info.matId === dirt.id;
  const isRSoil = rsoil && info.matId === rsoil.id;
  if (!isDirt && !isRSoil) continue;

  // count Mycelium neighbors of the candidate soil cell
  let mycCount = 0;
  for (const dd of deltas) {
    const cx = nx + dd[0], cy = ny + dd[1];
    const cinfo = canvas.get(cx, cy);
    if (!cinfo) continue;
    if (cinfo.matId === myc.id) mycCount++;
  }
  if (mycCount !== 1) continue;

  // If target is Rich Soil, ensure it is not near the surface:
  if (isRSoil) {
    let nearSurface = false;
    for (const nn of deltas) {
      const ax = nx + nn[0], ay = ny + nn[1];
      const adj = canvas.get(ax, ay);
      if (!adj) continue;
      // check neighbors of this adjacent cell for air
      for (const nn2 of deltas) {
        const bx = ax + nn2[0], by = ay + nn2[1];
        const binfo = canvas.get(bx, by);
        if (!binfo) continue;
        if (binfo.matId === 0) { nearSurface = true; break; }
      }
      if (nearSurface) break;
    }
    if (nearSurface) continue;
  }

  // chance to convert
  if (Math.random() < 0.05) {
    canvas.set(nx, ny, 'Mycelium');
    return; // only convert one per tick
  }
}
`,
    scriptInterval: 1,
    scriptParams: {}
  },

  // ---------- Bacteria ----------
  {
    name: "Bacteria",
    short: "BACT",
    description_short: "Warm-growing liquid that consumes organics and can replicate into nearby cells.",
    state: "liquid",
    category: "organic",
    color: "#d7ff9a",
    colorVar: 0.10,
    density: 1.0,
    viscosity: 0.25,
    conductivity: 0.10,
    heatCapacity: 1.0,
    decayChance: 0.0,
    decayInto: "Air",
    // Warm growth; consumes nearby organics; slowly self-replicates.
    script: `
const t = (typeof this.temp === 'number') ? this.temp : 20;
if (t < 28 || t > 55) {
  // outside growth band: slowly die out
  if (Math.random() < 0.01) canvas.set(this.x, this.y, 'Air');
  return;
}

const grass = game.getMat('Grass');
const moss = game.getMat('Moss');
const mold = game.getMat('Mold');
const myc = game.getMat('Mycelium');
const rsoil = game.getMat('Rich Soil');
const dirt = game.getMat('Dirt');

// consume adjacent organics (turn them into Rich Soil or Air)
let ate = false;
canvas.forEachNeighbor(this.x, this.y, (n) => {
  if (ate) return;
  if (!n.matId) return;

  const isOrganic =
    (grass && n.matId === grass.id) ||
    (moss && n.matId === moss.id) ||
    (mold && n.matId === mold.id) ||
    (myc && n.matId === myc.id);

  if (isOrganic) {
    // convert consumed cell
    if (rsoil && Math.random() < 0.70) canvas.set(n.x, n.y, 'Rich Soil');
    else canvas.set(n.x, n.y, 'Air');
    ate = true;
  }
});

// replicate into adjacent water-ish / empty if it just ate
if (ate && Math.random() < 0.12) {
  const neigh = [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  const d = neigh[Math.floor(Math.random()*neigh.length)];
  const nx = this.x + d[0], ny = this.y + d[1];
  const info = canvas.get(nx, ny);
  if (!info) return;
  // replicate into Air or Dirt (dirt becomes bacteria puddle)
  if (info.matId === 0) canvas.set(nx, ny, 'Bacteria');
  else if (dirt && info.matId === dirt.id) canvas.set(nx, ny, 'Bacteria');
}
`,
    scriptInterval: 10
  },
    {
    name: "Radium",
    short: "RADI",
    description_short: "Radioactive nuclear solid that slowly decays and can emit neutrons.",
    state: "solid",
    category: "nuclear",
    color: "#56ff7a",
    colorVar: 0.06,
    density: 5.5,
    powder: 0.02,
    viscosity: 0.0,
    dispersion: 0.0,
    conductivity: 0.10,
    heatCapacity: 0.35,
    heatSource: 0.02,       // mild self-heating
    nuclear: true,
    immovable: true,

    // Occasional decay (into Lead) using the built-in decay system.
    // Tune this: 0.00005 ≈ one decay per ~5.5 hours per cell on average (since chance/sec).
    decayChance: 0.00005,
    decayInto: "Lead",

    meltTemp: null, meltInto: "Molten Lead", // optional; or set null to avoid melting
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air",

    // Emits neutrons by placing Neutron entities into adjacent Air occasionally.
    script: `
const n = game.getMat('Neutron');
if (!n) return;

// emission rate (per script tick)
const p = 0.02; // 2% chance per scriptInterval to emit a neutron
if (Math.random() > p) return;

// find a nearby empty spot
const neigh = [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
for (let i = 0; i < neigh.length; i++) {
  const d = neigh[(Math.random() * neigh.length) | 0];
  const nx = this.x + d[0], ny = this.y + d[1];
  const info = canvas.get(nx, ny);
  if (!info) continue;
  if (info.matId === 0) { // Air
    // spawn a Neutron entity rather than placing a grid cell
    // give a small random velocity so it moves away from source
    const vx = (Math.random() - 0.5) * 2;
    const vy = (Math.random() - 0.5) * 2;
    if (game && typeof game.spawnEntity === 'function') {
      game.spawnEntity(nx + 0.0, ny + 0.0, 'Neutron', { vx, vy, life: 300 });
    } else {
      // fallback: place as grid cell
      canvas.set(nx, ny, 'Neutron');
    }
    break;
  }
}
`,
    scriptInterval: 6,
    scriptParams: {}
  },

  {
    name: "Thorium",
    short: "THOR",
    description_short: "Nuclear solid that can absorb neutrons and transmute into uranium or plutonium.",
    state: "solid",
    category: "nuclear",
    color: "#7fbf8a",
    colorVar: 0.06,
    density: 11.7,
    powder: 0.02,
    conductivity: 0.12,
    heatCapacity: 0.25,
    heatSource: 0.0,
    nuclear: true,
    immovable: true,

    decayChance: 0.00001,
    decayInto: "Lead",

    meltTemp: null, meltInto: "Lava",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air",

    // Neutron interaction hook:
    // Your neutron behavior needs to call this script (or otherwise consult a flag)
    // and respect: { absorbNeutron: true, transmuteInto: 'Uranium'|'Plutonium' }.
    script: `
/*
Expected call pattern (engine-side idea):
- When a Neutron tries to interact with a cell that has a script, call it with params like { event: 'neutron_hit' }.
- If it returns { absorbNeutron: true }, remove the neutron.
- If it returns { transmuteInto: 'Uranium' }, convert this cell.

If your engine *doesn't* pass events, this script will be inert unless you add that.
*/
if (!params || params.event !== 'neutron_hit') return;

const absorbChance = (params.absorbChance != null) ? Number(params.absorbChance) : 0.35;
if (Math.random() >= absorbChance) return { absorbNeutron: false };

// absorbed -> 50/50 transmute
const into = (Math.random() < 0.5) ? 'Uranium' : 'Plutonium';
return { absorbNeutron: true, transmuteInto: into };
`,
    scriptInterval: 1,
    scriptParams: { absorbChance: 0.35 }
  },

  {
    name: "Neutronium",
    short: "NEUT",
    description_short: "Ultra-dense indestructible nuclear solid that blocks changes and has no phase transitions.",
    state: "solid",
    category: "nuclear",
    color: "#0b1a66",
    colorVar: 1,
    density: 250.0,     // extremely dense
    powder: 0.0,
    conductivity: 0.0, // you can make it lower if you want it more insulator-like
    heatCapacity: 0.0, // “temperature changes slower”
    heatSource: 0.0,
    nuclear: true,
    immovable: true,

    // “Indestructible” via no phase changes + no decay.
    // If your engine has a hard-delete or dissolve mechanic, you’ll also want to honor an `indestructible` flag there.
    indestructible: true,

    decayChance: 0.0,
    decayInto: "Air",

    meltTemp: null, meltInto: "Air",
    freezeTemp: null, freezeInto: "Air",
    boilTemp: null, boilInto: "Air",
    condenseTemp: null, condenseInto: "Air",

    // Optional safety net: if something changes it (scripts/acid), revert back.
    script: `
/*
If you have mechanics that overwrite materials directly (acid dissolve, void, etc.),
they won't call this. To fully enforce indestructible, engine-side checks are needed.
*/
return;
`,
    scriptInterval: 60
  }
];



export const DEFAULT_MATERIALS = buildMaterialsTable([MATERIALS, ADDITIONAL_MATERIALS])