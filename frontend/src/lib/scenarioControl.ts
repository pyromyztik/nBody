export const STABLE_ORBIT_FAMILIES = [
  'auto',
  'polygon',
  'multiring',
  'wheel',
  'hierarchical',
  'bhh',
  'suvakov-dmitrasinovic',
  'retrograde',
  'interplay',
  'figure8',
  'lagrange-3',
  'euler-3'
] as const;

const MIN_SCENARIO_BODIES = 2;
const MIN_ACCRETION_DISK_RADIUS = 0;
const ACCRETION_DISK_RADIUS_PER_BODY = 1 / 30;
const MIN_AUTO_ACCRETION_DISK_RADIUS = 5;

export type StableOrbitFamily = (typeof STABLE_ORBIT_FAMILIES)[number];

export type ScenarioKind =
  | 'galaxy'
  | 'galaxy-10k'
  | 'galaxy-collision'
  | 'galaxy-collision-15k'
  | 'stable-orbits'
  | 'accretion-disk';

export type ScenarioSelection =
  | {
      kind: 'galaxy';
    }
  | {
      kind: 'galaxy-10k';
    }
  | {
      kind: 'galaxy-collision';
    }
  | {
      kind: 'galaxy-collision-15k';
    }
  | {
      kind: 'stable-orbits';
      stableFamily: StableOrbitFamily;
      bodyCount: number;
    }
  | {
      kind: 'accretion-disk';
      bodyCount: number;
      maxRadius: number;
    };

const STABLE_ORBIT_FAMILY_LOOKUP = new Set<string>(STABLE_ORBIT_FAMILIES);

function validateStableOrbitBodyCount(family: StableOrbitFamily, bodyCount: number): string | null {
  if (family === 'lagrange-3' || family === 'euler-3') {
    return bodyCount === 3 ? null : `Family ${family} requires exactly 3 bodies.`;
  }

  let minimumBodies = MIN_SCENARIO_BODIES;

  if (family === 'multiring') {
    minimumBodies = 4;
  } else if (
    family === 'wheel'
    || family === 'hierarchical'
    || family === 'retrograde'
    || family === 'interplay'
    || family === 'figure8'
    || family === 'bhh'
    || family === 'suvakov-dmitrasinovic'
  ) {
    minimumBodies = 3;
  }

  if (bodyCount < minimumBodies) {
    return `Family ${family} requires at least ${minimumBodies} bodies.`;
  }

  return null;
}

function isValidBodyCount(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_SCENARIO_BODIES;
}

function isValidAccretionDiskRadius(value: number): boolean {
  return Number.isFinite(value) && value > MIN_ACCRETION_DISK_RADIUS;
}

export function deriveAccretionDiskRadiusFromBodyCount(bodyCount: number): number {
  if (!isValidBodyCount(bodyCount)) {
    return MIN_AUTO_ACCRETION_DISK_RADIUS;
  }

  return Math.max(
    MIN_AUTO_ACCRETION_DISK_RADIUS,
    bodyCount * ACCRETION_DISK_RADIUS_PER_BODY
  );
}

export function validateScenarioSelection(selection: ScenarioSelection): string | null {
  if (
    selection.kind === 'galaxy' ||
    selection.kind === 'galaxy-10k' ||
    selection.kind === 'galaxy-collision' ||
    selection.kind === 'galaxy-collision-15k'
  ) {
    return null;
  }

  if (!isValidBodyCount(selection.bodyCount)) {
    return `Body count must be an integer >= ${MIN_SCENARIO_BODIES}.`;
  }

  if (selection.kind === 'stable-orbits') {
    if (!STABLE_ORBIT_FAMILY_LOOKUP.has(selection.stableFamily)) {
      return 'Stable-orbit family is invalid.';
    }

    return validateStableOrbitBodyCount(selection.stableFamily, selection.bodyCount);
  }

  if (!isValidAccretionDiskRadius(selection.maxRadius)) {
    return 'Accretion-disk radius must be a number greater than 0.';
  }

  return null;
}

export function formatScenarioStartMessage(selection: ScenarioSelection): string | null {
  const error = validateScenarioSelection(selection);
  if (error !== null) {
    return null;
  }

  const params = new URLSearchParams();
  params.set('kind', selection.kind);

  if (selection.kind === 'stable-orbits') {
    params.set('family', selection.stableFamily);
    params.set('bodies', String(selection.bodyCount));
  } else if (selection.kind === 'accretion-disk') {
    params.set('bodies', String(selection.bodyCount));
    params.set('radius', String(selection.maxRadius));
  }

  return `scenario:start?${params.toString()}`;
}
