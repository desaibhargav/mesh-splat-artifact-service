// Ordered finest first, matching PlayCanvas's LOD 0 convention.
export const LOD_RATIOS = [0.7, 0.5, 0.3] as const;
export const LOD_POLICY_VERSION = 1;

export function lodTargets(sourceCount: number) {
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 4) {
    throw new Error("LOD generation requires at least four source primitives.");
  }
  return LOD_RATIOS.map((ratio, level) => ({
    level, ratio, count: Math.max(1, Math.floor(sourceCount * ratio))
  }));
}

export function assertLodCount(actual: number, target: number): void {
  if (!Number.isSafeInteger(actual) || actual < 1 || actual > target) {
    throw new Error(`LOD primitive count ${actual} exceeds its permitted budget ${target}, or is empty. Output not published.`);
  }
}
