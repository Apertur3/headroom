export const now = new Date("2026-10-18T12:00:00Z");
export const at = (minutes) => new Date(now.getTime() + minutes * 60_000).toISOString();
export const reading = (overrides = {}) => ({
  meter: "quota", windowMinutes: 300, usedPercent: 50,
  resetsAt: at(150), fetchedAt: now.toISOString(), ...overrides,
});
