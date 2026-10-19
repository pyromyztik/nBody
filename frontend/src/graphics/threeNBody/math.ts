import { Vector3 } from '@babylonjs/core';

export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function computeBounds(positions: Float32Array, count: number, centerOut: Vector3): number {
  if (count === 0) {
    centerOut.set(0, 0, 0);
    return 1;
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < count; i++) {
    const idx = i * 3;
    const x = positions[idx];
    const y = positions[idx + 1];
    const z = positions[idx + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  centerOut.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);

  let maxR2 = 0;
  for (let i = 0; i < count; i++) {
    const idx = i * 3;
    const dx = positions[idx] - centerOut.x;
    const dy = positions[idx + 1] - centerOut.y;
    const dz = positions[idx + 2] - centerOut.z;
    const r2 = dx * dx + dy * dy + dz * dz;
    if (r2 > maxR2) maxR2 = r2;
  }

  const radius = Math.sqrt(maxR2);
  return Number.isFinite(radius) && radius > 0 ? radius : 1;
}

export function percentileRange(
  values: Float32Array,
  count: number,
  lowPercent: number,
  highPercent: number,
  scratch?: Float32Array
): [number, number] {
  if (count <= 0) return [0, 1];

  // For large body counts (e.g. 30k in Galaxy Collision), strided subsampling of ~1024 points
  // provides high statistical precision (< 0.5% percentile error) while eliminating ~99% of quickSelect work.
  const maxSamples = 1024;
  let sampleCount = count;
  let sorted: Float32Array;

  if (count > maxSamples) {
    sampleCount = maxSamples;
    const stride = Math.floor(count / maxSamples);
    sorted = scratch && scratch.length >= maxSamples ? scratch : new Float32Array(maxSamples);
    for (let i = 0; i < maxSamples; i++) {
      sorted[i] = values[i * stride];
    }
  } else {
    sorted = scratch && scratch.length >= count ? scratch : new Float32Array(count);
    sorted.set(values.subarray(0, count));
  }

  const lowIndex = Math.floor((sampleCount - 1) * lowPercent);
  const highIndex = Math.floor((sampleCount - 1) * highPercent);
  const low = quickSelect(sorted, lowIndex, sampleCount);
  const high = highIndex === lowIndex ? low : quickSelect(sorted, highIndex, sampleCount);

  if (!Number.isFinite(low) || !Number.isFinite(high)) return [0, 1];
  if (high <= low) return [low, low + 1];
  return [low, high];
}

function quickSelect(values: Float32Array, targetIndex: number, count: number): number {
  let left = 0;
  let right = count - 1;

  while (left < right) {
    let pivotIndex = (left + right) >> 1;
    pivotIndex = partition(values, left, right, pivotIndex);

    if (targetIndex === pivotIndex) {
      return values[pivotIndex];
    }

    if (targetIndex < pivotIndex) {
      right = pivotIndex - 1;
    } else {
      left = pivotIndex + 1;
    }
  }

  return values[left];
}

function partition(values: Float32Array, left: number, right: number, pivotIndex: number): number {
  const pivotValue = values[pivotIndex];
  swap(values, pivotIndex, right);

  let storeIndex = left;
  for (let i = left; i < right; i += 1) {
    if (values[i] < pivotValue) {
      swap(values, storeIndex, i);
      storeIndex += 1;
    }
  }

  swap(values, right, storeIndex);
  return storeIndex;
}

function swap(values: Float32Array, a: number, b: number): void {
  if (a === b) {
    return;
  }

  const temp = values[a];
  values[a] = values[b];
  values[b] = temp;
}
