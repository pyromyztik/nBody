import {
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Quaternion,
  Scene,
  StandardMaterial,
  Vector3,
  VertexBuffer
} from '@babylonjs/core';
import { randomIndexedColor, turboColor } from './color';
import { clamp01 } from './math';

export type BodyRenderTheme = 'default' | 'stable-orbits';

export type BodyInstancesRenderer = {
  mesh: Mesh;
  material: PBRMaterial;
  pointMesh: Mesh;
  pointMaterial: StandardMaterial;
  setBodyRadius: (value: number) => void;
  update: (
    positions: Float32Array,
    speeds: Float32Array,
    count: number,
    speedMin: number,
    speedSpan: number,
    cameraPos: Vector3,
    billboardDistanceSq: number,
    colorsDirty?: boolean
  ) => void;
  dispose: () => void;
};

export function createBodyInstancesRenderer(
  scene: Scene,
  renderTheme: BodyRenderTheme = 'default',
  stableColorSeed = 0
): BodyInstancesRenderer {
  const useStableOrbitTheme = renderTheme === 'stable-orbits';
  const stableSphereColorIntensity = 1.28;
  const stablePointColorIntensity = 1.12;

  const mesh = MeshBuilder.CreateSphere('body', { diameter: 2, segments: 16 }, scene);
  const material = new PBRMaterial(useStableOrbitTheme ? 'body-mat-stable' : 'body-mat', scene);
  material.albedoColor = Color3.White();
  if (useStableOrbitTheme) {
    material.unlit = true;
    material.metallic = 0.0;
    material.roughness = 1.0;
    material.emissiveColor = new Color3(0.16, 0.16, 0.16);
    material.emissiveIntensity = 1.0;
  } else {
    material.metallic = 0.99;
    material.roughness = 0.5;
    material.emissiveColor = Color3.Black();
    material.emissiveIntensity = 1.0;
  }
  material.useRoughnessFromMetallicTextureAlpha = false;
  mesh.material = material;
  mesh.useVertexColors = true;
  mesh.hasVertexAlpha = false;
  mesh.thinInstanceEnablePicking = false;
  mesh.renderingGroupId = 1;

  const pointMesh = new Mesh('body-points', scene);
  const pointMaterial = new StandardMaterial('body-points-mat', scene);
  pointMaterial.disableLighting = true;
  pointMaterial.pointsCloud = true;
  pointMaterial.pointSize = useStableOrbitTheme ? 2.6 : 1.25;
  pointMaterial.alpha = useStableOrbitTheme ? 0.98 : 0.5;
  pointMaterial.emissiveColor = useStableOrbitTheme
    ? new Color3(0.3, 0.3, 0.3)
    : Color3.White();
    
  pointMaterial.disableDepthWrite = true;
  pointMaterial.backFaceCulling = false;
  pointMesh.material = pointMaterial;
  pointMesh.useVertexColors = true;
  pointMesh.hasVertexAlpha = true;
  pointMesh.isPickable = false;
  pointMesh.alwaysSelectAsActiveMesh = true;
  pointMesh.setEnabled(false);
  pointMesh.renderingGroupId = 0;

  const identityQuat = Quaternion.Identity();
  const tmpMatrix = new Matrix();
  const tmpPos = new Vector3();
  const tmpScale = new Vector3(1, 1, 1);
  const tmpColor = new Color3();

  let bodyRadius = 0.01;
  let matrixData = new Float32Array(0);
  let colorData = new Float32Array(0);
  let baseColors = new Float32Array(0);
  let pointPositions = new Float32Array(0);
  let pointColors = new Float32Array(0);
  let pointIndices: number[] = [];

  const setBodyRadius = (value: number) => {
    bodyRadius = value;
  };

  let cachedSphereCount = 0;
  let cachedFarBodyCount = 0;

  const update = (
    positions: Float32Array,
    speeds: Float32Array,
    count: number,
    speedMin: number,
    speedSpan: number,
    cameraPos: Vector3,
    billboardDistanceSq: number,
    colorsDirty = true
  ) => {
    const bufferSizeChanged = pointPositions.length !== count * 3;
    if (matrixData.length !== count * 16) {
      matrixData = new Float32Array(count * 16);
      mesh.thinInstanceSetBuffer('matrix', matrixData, 16, false);
      mesh.thinInstanceAllowAutomaticStaticBufferRecreation = true;
    }

    if (colorData.length !== count * 4) {
      colorData = new Float32Array(count * 4);
      mesh.thinInstanceSetBuffer('color', colorData, 4, false);
    }

    if (baseColors.length !== count * 3) {
      baseColors = new Float32Array(count * 3);
    }

    if (bufferSizeChanged) {
      pointPositions = new Float32Array(count * 3);
      pointColors = new Float32Array(count * 4);
      pointIndices = new Array<number>(count);
      for (let i = 0; i < count; i++) pointIndices[i] = i;
      pointMesh.setVerticesData(VertexBuffer.PositionKind, pointPositions, true, 3);
      pointMesh.setVerticesData(VertexBuffer.ColorKind, pointColors, true, 4);
      pointMesh.setIndices(pointIndices);
    }

    const sphereColorScale = useStableOrbitTheme ? stableSphereColorIntensity : 1;
    const pointColorScale = useStableOrbitTheme ? stablePointColorIntensity : 1;
    const shouldUpdateColors = colorsDirty || bufferSizeChanged;

    if (shouldUpdateColors) {
      for (let i = 0; i < count; i++) {
        if (useStableOrbitTheme) {
          randomIndexedColor(i, tmpColor, stableColorSeed);
        } else {
          const t = speedSpan > 1e-5 ? clamp01((speeds[i] - speedMin) / speedSpan) : 0.5;
          turboColor(t, tmpColor);
        }
        const b = i * 3;
        baseColors[b] = tmpColor.r;
        baseColors[b + 1] = tmpColor.g;
        baseColors[b + 2] = tmpColor.b;

        const c = i * 4;
        pointColors[c] = tmpColor.r * pointColorScale;
        pointColors[c + 1] = tmpColor.g * pointColorScale;
        pointColors[c + 2] = tmpColor.b * pointColorScale;
      }
    }

    tmpScale.set(bodyRadius, bodyRadius, bodyRadius);
    let sphereCount = 0;
    let farBodyCount = 0;

    // Bulk copy positions directly into vertex buffer array
    pointPositions.set(positions.subarray(0, count * 3));

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const px = positions[idx];
      const py = positions[idx + 1];
      const pz = positions[idx + 2];
      const dx = px - cameraPos.x;
      const dy = py - cameraPos.y;
      const dz = pz - cameraPos.z;
      const distanceSq = dx * dx + dy * dy + dz * dz;

      const shouldUsePointSprite = distanceSq > billboardDistanceSq;
      const c = i * 4;

      if (shouldUsePointSprite) {
        pointColors[c + 3] = useStableOrbitTheme ? 0.96 : 0.5;
        farBodyCount += 1;
      } else {
        pointColors[c + 3] = 0;
        tmpPos.set(px, py, pz);
        Matrix.ComposeToRef(tmpScale, identityQuat, tmpPos, tmpMatrix);
        tmpMatrix.copyToArray(matrixData, sphereCount * 16);

        const sphereColor = sphereCount * 4;
        const b = i * 3;
        colorData[sphereColor] = baseColors[b] * sphereColorScale;
        colorData[sphereColor + 1] = baseColors[b + 1] * sphereColorScale;
        colorData[sphereColor + 2] = baseColors[b + 2] * sphereColorScale;
        colorData[sphereColor + 3] = 1;
        sphereCount += 1;
      }
    }

    mesh.thinInstanceCount = sphereCount;
    if (sphereCount > 0 || cachedSphereCount > 0) {
      mesh.thinInstanceBufferUpdated('matrix');
      mesh.thinInstanceBufferUpdated('color');
    }

    pointMesh.updateVerticesData(VertexBuffer.PositionKind, pointPositions, false, false);
    if (shouldUpdateColors) {
      pointMesh.updateVerticesData(VertexBuffer.ColorKind, pointColors, false, false);
    }

    pointMesh.setEnabled(farBodyCount > 0);
    mesh.setEnabled(sphereCount > 0);

    cachedSphereCount = sphereCount;
    cachedFarBodyCount = farBodyCount;
  };

  const dispose = () => {
    mesh.dispose(false, true);
    material.dispose();
    pointMesh.dispose(false, true);
    pointMaterial.dispose();
  };

  return {
    mesh,
    material,
    pointMesh,
    pointMaterial,
    setBodyRadius,
    update,
    dispose
  };
}
