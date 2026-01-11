export const DEFAULT_RECIPES = [
  // keep your originals if you want; these are “harder to do by accident”
  {
    name: "Nuclear Fusion",
    inputs: [
      { mat: "Hydrogen", count: 2, radius: 3 },
    ],
    tempMin: 10000, tempMax: null,
    chance: 0.35,
    interval: 10,
    sampleRate: 0.15,
    result: { mat: "Helium", consumeInputs: true }
  },

  {
    name: "Salt Water Formation (tight cluster)",
    inputs: [
      { mat: "Water", count: 3, radius: 1 },
      { mat: "Salt",  count: 2, radius: 1 }
    ],
    tempMin: 5, tempMax: 40,
    chance: 0.35,
    interval: 10,
    sampleRate: 0.15,
    result: { mat: "Salt Water", consumeInputs: true }
  },

  {
    name: "Steam Synthesis (H2 + O2, hot + compressed)",
    inputs: [
      { mat: "Hydrogen", count: 6, radius: 1 },
      { mat: "Oxygen",   count: 3, radius: 1 }
    ],
    tempMin: 250, tempMax: 800,
    chance: 0.04,
    interval: 8,
    sampleRate: 0.12,
    result: { mat: "Steam", temp: 350, consumeInputs: true }
  },

  {
    name: "Mud Formation (Water + Dirt, packed)",
    inputs: [
      { mat: "Water", count: 3, radius: 1 },
      { mat: "Dirt",  count: 3, radius: 1 }
    ],
    tempMin: 5, tempMax: 45,
    chance: 0.20,
    interval: 12,
    sampleRate: 0.14,
    result: { mat: "Mud", consumeInputs: true }
  },

  {
    name: "Concrete Setting (Sand + Water + Gravel, cool + compressed)",
    inputs: [
      { mat: "Sand",   count: 5, radius: 1 },
      { mat: "Water",  count: 2, radius: 1 },
      { mat: "Gravel", count: 3, radius: 1 }
    ],
    tempMin: 5, tempMax: 35,
    chance: 0.10,
    interval: 16,
    sampleRate: 0.10,
    result: { mat: "Concrete", consumeInputs: true }
  },

  {
    name: "Glass Smelting (Sand + Lava -> Molten Glass, very hot)",
    inputs: [
      { mat: "Sand", count: 6, radius: 1 },
      { mat: "Lava", count: 1, radius: 1 }
    ],
    tempMin: 1200, tempMax: Infinity,
    chance: 0.08,
    interval: 10,
    sampleRate: 0.10,
    result: { mat: "Molten Glass", temp: 1100, consumeInputs: true }
  },

  {
    name: "Glass Casting (Molten Glass + Coolant -> Glass, narrow temp window)",
    inputs: [
      { mat: "Molten Glass", count: 2, radius: 1 },
      { mat: "Coolant",      count: 1, radius: 1 }
    ],
    tempMin: 700, tempMax: 950,
    chance: 0.22,
    interval: 10,
    sampleRate: 0.12,
    result: { mat: "Glass", temp: 200, consumeInputs: true }
  },

  {
    name: "Obsidian Quench (Lava + Water + Stone, fast quench)",
    inputs: [
      { mat: "Lava",  count: 1, radius: 1 },
      { mat: "Water", count: 3, radius: 1 },
      { mat: "Stone", count: 2, radius: 1 }
    ],
    tempMin: 600, tempMax: Infinity,
    chance: 0.14,
    interval: 8,
    sampleRate: 0.10,
    result: { mat: "Obsidian", temp: 250, consumeInputs: true }
  },

  {
    name: "Salt Crystallization (Salt Water + Coolant, cold + compressed)",
    inputs: [
      { mat: "Salt Water", count: 3, radius: 1 },
      { mat: "Coolant",    count: 1, radius: 1 }
    ],
    tempMin: -10, tempMax: 2,
    chance: 0.18,
    interval: 14,
    sampleRate: 0.10,
    result: { mat: "Salt", consumeInputs: true }
  },

  {
    name: "Snow Packing (Snow + Ice, subzero + high pressure)",
    inputs: [
      { mat: "Snow", count: 6, radius: 1 },
      { mat: "Ice",  count: 2, radius: 1 }
    ],
    tempMin: -40, tempMax: -1,
    chance: 0.10,
    interval: 18,
    sampleRate: 0.08,
    result: { mat: "Ice", consumeInputs: true }
  },

  {
    name: "Ash Slurry (Water + Ash, packed)",
    inputs: [
      { mat: "Water", count: 2, radius: 1 },
      { mat: "Ash",   count: 4, radius: 1 }
    ],
    tempMin: 5, tempMax: 50,
    chance: 0.16,
    interval: 14,
    sampleRate: 0.10,
    result: { mat: "Mud", consumeInputs: true }
  }
];

export default DEFAULT_RECIPES;
