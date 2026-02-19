const adjectives = [
  "Swift", "Calm", "Bold", "Bright", "Warm", "Keen", "Vast", "Crisp", "Agile", "Noble",
  "Vivid", "Lucid", "Brisk", "Deft", "Fleet", "Grand", "Lush", "Prime", "Sage", "True",
  "Clear", "Deep", "Fair", "Firm", "Glad", "Kind", "Pure", "Rich", "Safe", "Wise",
  "Fresh", "Sharp", "Steady", "Quick", "Gentle", "Silent", "Golden", "Radiant", "Serene", "Verdant",
];

const nouns = [
  "Falcon", "River", "Cedar", "Stone", "Ember", "Frost", "Bloom", "Ridge", "Crane", "Birch",
  "Coral", "Dawn", "Flint", "Grove", "Heron", "Lark", "Maple", "Opal", "Pearl", "Quartz",
  "Reef", "Sage", "Tide", "Vale", "Wren", "Aspen", "Brook", "Cliff", "Delta", "Eagle",
  "Fern", "Harbor", "Iris", "Jade", "Lotus", "Mesa", "Nova", "Orbit", "Pebble", "Summit",
];

function hashString(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function generateSessionName(sessionId: string): string {
  const h = hashString(sessionId);
  const adj = adjectives[h % adjectives.length]!;
  const noun = nouns[Math.floor(h / adjectives.length) % nouns.length]!;
  return `${adj} ${noun}`;
}
