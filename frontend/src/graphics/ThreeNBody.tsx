import React, { useEffect, useRef } from 'react';
import {
  Constants,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  Engine,
  GlowLayer,
  HemisphericLight,
  Scene,
  UniversalCamera,
  Vector3
} from '@babylonjs/core';
import {
  DESKTOP_BILLBOARD_SWITCH_DISTANCE,
  MOBILE_BILLBOARD_SWITCH_DISTANCE,
  BODY_SPHERE_RADIUS,
  VECTOR_OVERLAY_SCALE_RADIUS
} from '../lib/config';
import { useFrameStore } from '../state/useFrameStore';
import {
  createBodyInstancesRenderer,
  type BodyRenderTheme
} from './threeNBody/bodyInstances';
import { createCameraRig } from './threeNBody/cameraRig';
import { computeBounds, percentileRange } from './threeNBody/math';
import { createOrbitTrailManager } from './threeNBody/orbitTrails';
import { createVectorOverlayManager } from './threeNBody/vectorOverlays';
import { createWorldGridRenderer } from './threeNBody/worldGrid';

type ThreeNBodyProps = {
  virtualMoveX?: number;
  virtualMoveY?: number;
  renderTheme?: BodyRenderTheme;
};

const MIN_BODY_INTERPOLATION_MS = 2;
const MAX_BODY_INTERPOLATION_MS = 500;

export const ThreeNBody = React.memo(function ThreeNBody({
  virtualMoveX = 0,
  virtualMoveY = 0,
  renderTheme = 'default'
}: ThreeNBodyProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const virtualMoveRef = useRef({ x: virtualMoveX, y: virtualMoveY });

  virtualMoveRef.current.x = virtualMoveX;
  virtualMoveRef.current.y = virtualMoveY;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const useStableOrbitTheme = renderTheme === 'stable-orbits';
    const isMobile =
      typeof navigator !== 'undefined' &&
      (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
        (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches));

    const maxRenderPixelRatio = isMobile ? 2 : (useStableOrbitTheme ? 2.5 : 1.5);
    const stableColorSeed = Math.floor(Math.random() * 1_000_000_000);

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    host.appendChild(canvas);

    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    });
    engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, maxRenderPixelRatio));
    const preventContextMenu = (ev: Event) => ev.preventDefault();
    canvas.addEventListener('contextmenu', preventContextMenu);

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const camera = new UniversalCamera('camera', new Vector3(0, 0, 3), scene);
    camera.fov = Math.PI / 2.5;
    camera.minZ = 0.01;
    camera.maxZ = 10000;
    camera.inputs.clear();
    camera.upVector = Vector3.Up();

    // Dynamic bloom: blur the live scene each frame using a downsampled pass 
    const renderingPipeline = new DefaultRenderingPipeline(
      'nBodyRenderingPipeline',
      true,
      scene,
      [camera]
    );
    renderingPipeline.bloomEnabled = true;
    renderingPipeline.bloomThreshold = useStableOrbitTheme ? 0.08 : 0;
    renderingPipeline.bloomKernel = isMobile ? (useStableOrbitTheme ? 32 : 48) : (useStableOrbitTheme ? 60 : 220);
    renderingPipeline.bloomWeight = useStableOrbitTheme ? 0.12 : 0.01;
    renderingPipeline.bloomScale = isMobile ? 0.5 : (useStableOrbitTheme ? 0.9 : 0.5);
    renderingPipeline.samples = isMobile
      ? Math.max(1, Math.min(2, engine.getCaps().maxMSAASamples || 1))
      : (useStableOrbitTheme
        ? Math.max(1, Math.min(8, engine.getCaps().maxMSAASamples || 1))
        : Math.max(1, Math.min(4, engine.getCaps().maxMSAASamples || 1)));

    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
    hemi.intensity = useStableOrbitTheme ? 0.08 : 0.35;
    const dir = new DirectionalLight('dir', new Vector3(-2, -2, -2).normalize(), scene);
    dir.position = new Vector3(2, 2, 2);
    dir.intensity = useStableOrbitTheme ? 0.18 : 1.1;

    const bodyInstances = createBodyInstancesRenderer(scene, renderTheme, stableColorSeed);
    const vectorOverlays = createVectorOverlayManager(scene, renderTheme, stableColorSeed);
    let wideGlowLayer: GlowLayer | null = null;
    renderingPipeline.glowLayerEnabled = useStableOrbitTheme;
    if (useStableOrbitTheme && renderingPipeline.glowLayer) {
      const glowLayer = renderingPipeline.glowLayer;
      const velocityVectorMesh = vectorOverlays.getMesh('velocity');
      const accelerationVectorMesh = vectorOverlays.getMesh('acceleration');
      glowLayer.blurKernelSize = isMobile ? 8 : 16;
      glowLayer.intensity = 0.72;
      glowLayer.setExcludedByDefault(true);
      glowLayer.addIncludedOnlyMesh(bodyInstances.mesh);
      glowLayer.addIncludedOnlyMesh(bodyInstances.pointMesh);
      glowLayer.addIncludedOnlyMesh(velocityVectorMesh);
      glowLayer.addIncludedOnlyMesh(accelerationVectorMesh);
      glowLayer.referenceMeshToUseItsOwnMaterial(bodyInstances.mesh);
      glowLayer.referenceMeshToUseItsOwnMaterial(bodyInstances.pointMesh);
      glowLayer.referenceMeshToUseItsOwnMaterial(velocityVectorMesh);
      glowLayer.referenceMeshToUseItsOwnMaterial(accelerationVectorMesh);

      // Second large-radius glow pass only on desktop
      if (!isMobile) {
        wideGlowLayer = new GlowLayer('nbody-wide-glow', scene, {
          mainTextureRatio: 0.25,
          alphaBlendingMode: Constants.ALPHA_SCREENMODE,
          camera,
        });
        wideGlowLayer.blurKernelSize = 132;
        wideGlowLayer.intensity = 0.22;
        wideGlowLayer.setExcludedByDefault(true);
        wideGlowLayer.addIncludedOnlyMesh(bodyInstances.mesh);
        wideGlowLayer.addIncludedOnlyMesh(bodyInstances.pointMesh);
        wideGlowLayer.addIncludedOnlyMesh(velocityVectorMesh);
        wideGlowLayer.addIncludedOnlyMesh(accelerationVectorMesh);
        wideGlowLayer.referenceMeshToUseItsOwnMaterial(bodyInstances.mesh);
        wideGlowLayer.referenceMeshToUseItsOwnMaterial(bodyInstances.pointMesh);
        wideGlowLayer.referenceMeshToUseItsOwnMaterial(velocityVectorMesh);
        wideGlowLayer.referenceMeshToUseItsOwnMaterial(accelerationVectorMesh);
      }
    }

    const orbitTrails = createOrbitTrailManager(scene, renderTheme, stableColorSeed);
    const worldGrid = createWorldGridRenderer(scene);
    worldGrid.setVisible(useFrameStore.getState().showWorldGrid);

    let bodyRadius = BODY_SPHERE_RADIUS;
    let lastFrame = -1;
    let lastBodyCount = 0;
    let lastTime = performance.now();
    let displayPositions = new Float32Array(0);
    let blendStartPositions = new Float32Array(0);
    let blendTargetPositions = new Float32Array(0);
    let targetSpeeds = new Float32Array(0);
    let renderedSpeeds = new Float32Array(0);
    let blendStartTime = 0;
    let blendDurationMs = 0;
    let smoothedFrameIntervalMs = 1000 / 60;
    let blendActive = false;
    let hasInitialKeyframe = false;
    let colorsTransitioning = false;
    let boundsCenter = new Vector3(0, 0, 0);
    let boundsRadius = 1;
    let needsFit = true;
    let accelerationVectorScratch = new Float32Array(0);
    let accelerationMagnitudeScratch = new Float32Array(0);
    let percentileScratch = new Float32Array(0);
    let previousVelocitySnapshot = new Float32Array(0);
    let previousFrameSampleTime = 0;
    let previousVelocityVectorsVisible = false;
    let previousAccelerationVectorsVisible = false;
    let previousOrbitTrailsVisible = useFrameStore.getState().showOrbitTrails;
    let previousWorldGridVisible = useFrameStore.getState().showWorldGrid;
    let latestPositions: Float32Array | null = null;
    let latestVelocities: Float32Array | null = null;
    let latestAccelerationVectors: Float32Array | null = null;
    let latestAccelerationMagnitudes: Float32Array | null = null;
    let targetSpeedMin = 0;
    let targetSpeedSpan = 1;
    let latestSpeedMin = 0;
    let latestSpeedSpan = 1;
    let latestAccelerationMin = 0;
    let latestAccelerationSpan = 1;
    let lastVboUploadTime = 0;
    const vectorScaleRadius = VECTOR_OVERLAY_SCALE_RADIUS;
    const lastBodyUpdateCameraPos = new Vector3(Number.NaN, Number.NaN, Number.NaN);

    const cameraRig = createCameraRig({
      canvas,
      camera,
      getBoundsCenter: () => boundsCenter,
      getBoundsRadius: () => boundsRadius,
      getVirtualMoveAxes: () => virtualMoveRef.current,
      getInvertLook: () => useFrameStore.getState().invertLook,
      getBaseMoveSpeed: () => useFrameStore.getState().cameraBaseMoveSpeed,
      setBaseMoveSpeed: (speed) => useFrameStore.getState().setCameraBaseMoveSpeed(speed)
    });

    function isMobileDevice(): boolean {
      if (typeof window === 'undefined') return false;
      try {
        return (
          'ontouchstart' in window ||
          (navigator as any).maxTouchPoints > 0 ||
          (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
          window.innerWidth <= 768
        );
      } catch {
        return false;
      }
    }
    const BILLBOARD_SWITCH_DISTANCE = isMobileDevice()
      ? MOBILE_BILLBOARD_SWITCH_DISTANCE
      : DESKTOP_BILLBOARD_SWITCH_DISTANCE;

    const onResize = () => {
      engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, maxRenderPixelRatio));
      engine.resize();
    };

    window.addEventListener('resize', onResize);

    const ensureDisplayBuffers = (floatCount: number, bodyCount: number) => {
      if (displayPositions.length !== floatCount) {
        displayPositions = new Float32Array(floatCount);
        blendStartPositions = new Float32Array(floatCount);
        blendTargetPositions = new Float32Array(floatCount);
        blendActive = false;
        hasInitialKeyframe = false;
      }
      if (targetSpeeds.length !== bodyCount) {
        targetSpeeds = new Float32Array(bodyCount);
        renderedSpeeds = new Float32Array(bodyCount);
      }
    };

    const snapDisplayPositions = (positions: Float32Array, speeds?: Float32Array | null) => {
      const bodyCount = Math.floor(positions.length / 3);
      ensureDisplayBuffers(positions.length, bodyCount);
      displayPositions.set(positions);
      blendStartPositions.set(positions);
      blendTargetPositions.set(positions);
      if (speeds && speeds.length === bodyCount) {
        targetSpeeds.set(speeds);
        renderedSpeeds.set(speeds);
      }
      blendStartTime = 0;
      blendDurationMs = 0;
      blendActive = false;
      hasInitialKeyframe = true;
    };

    const beginDisplayInterpolation = (
      positions: Float32Array,
      durationMs: number,
      nowMs: number
    ) => {
      const bodyCount = Math.floor(positions.length / 3);
      ensureDisplayBuffers(positions.length, bodyCount);

      if (!hasInitialKeyframe || blendTargetPositions.length !== positions.length) {
        snapDisplayPositions(positions, null);
        return;
      }

      // Filter out network packet arrival jitter with exponential moving average
      if (durationMs >= 2 && durationMs <= 500) {
        smoothedFrameIntervalMs = smoothedFrameIntervalMs * 0.7 + durationMs * 0.3;
      }

      // Continuous C2 visual blending:
      // Start the new segment from where the bodies ACTUALLY are on screen right now!
      // This completely eliminates snapping/teleporting when packets arrive early or late.
      blendStartPositions.set(displayPositions);
      blendTargetPositions.set(positions);

      blendStartTime = nowMs;
      blendDurationMs = Math.min(
        MAX_BODY_INTERPOLATION_MS,
        Math.max(MIN_BODY_INTERPOLATION_MS, smoothedFrameIntervalMs)
      );
      blendActive = true;
    };

    const updateDisplayPositions = (nowMs: number) => {
      if (displayPositions.length === 0 || !blendActive || blendDurationMs <= 0) {
        return false;
      }

      const elapsed = nowMs - blendStartTime;
      const rawProgress = elapsed / blendDurationMs;
      const isPaused = useFrameStore.getState().simPaused;

      // When simulation is paused, clamp at 1.0.
      // When active, if the next packet is slightly delayed by network jitter,
      // apply an asymptotic soft ease-out towards 1.12 to prevent freeze without snapping back.
      let t: number;
      if (isPaused || rawProgress <= 1.0) {
        t = Math.min(1.0, Math.max(0, rawProgress));
      } else {
        t = 1.0 + (1.0 - Math.exp(-(rawProgress - 1.0) * 3.0)) * 0.12;
      }

      // Quintic SmootherStep: S(t) = 6t^5 - 15t^4 + 10t^3
      // S(0) = 0, S'(0) = 0, S''(0) = 0
      // S(1) = 1, S'(1) = 0, S''(1) = 0
      // Guarantees C2 boundary continuity from current visual position with zero velocity jerk!
      const t2 = t * t;
      const t3 = t2 * t;
      const progress = t3 * (t * (t * 6 - 15) + 10);

      const len = displayPositions.length;
      const startP = blendStartPositions;
      const targetP = blendTargetPositions;

      for (let i = 0; i < len; i++) {
        displayPositions[i] = startP[i] + (targetP[i] - startP[i]) * progress;
      }

      if (rawProgress >= 1.5 && isPaused) {
        displayPositions.set(blendTargetPositions);
        blendActive = false;
      }

      return true;
    };

    const renderLoop = () => {
      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      let frameChanged = false;
      // Advance any active interpolation before processing newly arrived samples.
      const displayPositionsChanged = updateDisplayPositions(now);

      // Advance 0.75-second continuous velocity color smoothing at native viewport refresh rate
      if (renderedSpeeds.length === lastBodyCount && lastBodyCount > 0) {
        const colorAlpha = Math.min(1.0, Math.max(0.001, 1 - Math.exp(-dt / 0.75)));
        let maxColorDelta = 0;
        for (let i = 0; i < lastBodyCount; i++) {
          const delta = targetSpeeds[i] - renderedSpeeds[i];
          renderedSpeeds[i] += delta * colorAlpha;
          const absDelta = Math.abs(delta);
          if (absDelta > maxColorDelta) maxColorDelta = absDelta;
        }
        colorsTransitioning = maxColorDelta > 1e-4;

        // Smooth palette normalization ranges across 0.75s
        const spanAlpha = Math.min(1.0, Math.max(0.001, 1 - Math.exp(-dt / 0.75)));
        latestSpeedMin = latestSpeedMin * (1 - spanAlpha) + targetSpeedMin * spanAlpha;
        latestSpeedSpan = latestSpeedSpan * (1 - spanAlpha) + targetSpeedSpan * spanAlpha;
      }

      const state = useFrameStore.getState();
      const {
        positions,
        velocities,
        frame,
        bodyCount,
        showVelocityVectors,
        showAccelerationVectors,
        showOrbitTrails,
        showWorldGrid,
        lastFrameTime
      } = state;

      if (!positions || bodyCount === 0) {
        if (lastBodyCount > 0) {
          displayPositions = new Float32Array(0);
          blendStartPositions = new Float32Array(0);
          blendTargetPositions = new Float32Array(0);
          targetSpeeds = new Float32Array(0);
          renderedSpeeds = new Float32Array(0);
          hasInitialKeyframe = false;
          blendActive = false;
          colorsTransitioning = false;
          lastBodyCount = 0;
          bodyInstances.mesh.setEnabled(false);
          bodyInstances.pointMesh.setEnabled(false);
          orbitTrails.clear();
          vectorOverlays.clear('velocity');
          vectorOverlays.clear('acceleration');
        }
        cameraRig.update(dt);
        scene.render();
        return;
      }

      const hasFreshFrameSample =
        frame !== lastFrame || lastFrameTime > previousFrameSampleTime;

      if (positions && velocities && hasFreshFrameSample) {
        frameChanged = true;
        const isResetOrRewind = frame < lastFrame;
        const frameIntervalMs =
          previousFrameSampleTime > 0 && lastFrameTime > previousFrameSampleTime
            ? lastFrameTime - previousFrameSampleTime
            : 1000 / 60;
        const shouldSnapDisplay =
          isResetOrRewind
          || displayPositions.length !== positions.length
          || lastBodyCount !== bodyCount
          || lastFrame < 0;

        if (targetSpeeds.length !== bodyCount) {
          targetSpeeds = new Float32Array(bodyCount);
          renderedSpeeds = new Float32Array(bodyCount);
        }

        for (let i = 0; i < bodyCount; i++) {
          const base = i * 3;
          const vx = velocities[base];
          const vy = velocities[base + 1];
          const vz = velocities[base + 2];
          targetSpeeds[i] = Math.sqrt(vx * vx + vy * vy + vz * vz);
        }

        const neededPercentileLen = Math.min(bodyCount, 1024);
        if (percentileScratch.length < neededPercentileLen) {
          percentileScratch = new Float32Array(neededPercentileLen);
        }

        const [speedMin, speedMax] = percentileRange(
          targetSpeeds,
          bodyCount,
          0.05,
          0.95,
          percentileScratch
        );
        const speedSpan = Math.max(speedMax - speedMin, 1e-6);
        targetSpeedMin = speedMin;
        targetSpeedSpan = speedSpan;

        if (isResetOrRewind || shouldSnapDisplay || latestSpeedSpan <= 1e-6) {
          renderedSpeeds.set(targetSpeeds);
          latestSpeedMin = targetSpeedMin;
          latestSpeedSpan = targetSpeedSpan;
        }

        if (shouldSnapDisplay) {
          snapDisplayPositions(positions, targetSpeeds);
          orbitTrails.clear();
          vectorOverlays.clear('velocity');
          vectorOverlays.clear('acceleration');
        } else {
          beginDisplayInterpolation(positions, frameIntervalMs, now);
        }

        if (frame < lastFrame) {
          previousVelocitySnapshot = new Float32Array(0);
          previousFrameSampleTime = 0;
        }

        if (lastBodyCount === 0 && bodyCount > 0) {
          needsFit = true;
        }
        lastBodyCount = bodyCount;

        boundsRadius = computeBounds(positions, bodyCount, boundsCenter);
        if (showAccelerationVectors) {
          if (accelerationVectorScratch.length !== bodyCount * 3) {
            accelerationVectorScratch = new Float32Array(bodyCount * 3);
          }
          if (accelerationMagnitudeScratch.length !== bodyCount) {
            accelerationMagnitudeScratch = new Float32Array(bodyCount);
          }
        }

        if (showAccelerationVectors) {
          const hasPrevious =
            !isResetOrRewind
            && previousVelocitySnapshot.length === velocities.length
            && lastFrame >= 0
            && frame > lastFrame;
          const frameDelta = hasPrevious ? frame - lastFrame : 1;
          const activeSimDt = state.simDt > 0 ? state.simDt : 0.016667;
          const effectiveSimDt = frameDelta * activeSimDt;
          const invDeltaTime = effectiveSimDt > 1e-6 ? 1 / effectiveSimDt : 0;

          if (hasPrevious && invDeltaTime > 0) {
            const accAlpha = Math.min(1.0, Math.max(0.12, frameIntervalMs / 120));
            const invAccAlpha = 1 - accAlpha;
            for (let i = 0; i < bodyCount; i++) {
              const base = i * 3;
              const rawAx = (velocities[base] - previousVelocitySnapshot[base]) * invDeltaTime;
              const rawAy = (velocities[base + 1] - previousVelocitySnapshot[base + 1]) * invDeltaTime;
              const rawAz = (velocities[base + 2] - previousVelocitySnapshot[base + 2]) * invDeltaTime;
              const curAx = accelerationVectorScratch[base];
              const curAy = accelerationVectorScratch[base + 1];
              const curAz = accelerationVectorScratch[base + 2];
              const ax = curAx * invAccAlpha + rawAx * accAlpha;
              const ay = curAy * invAccAlpha + rawAy * accAlpha;
              const az = curAz * invAccAlpha + rawAz * accAlpha;
              accelerationVectorScratch[base] = ax;
              accelerationVectorScratch[base + 1] = ay;
              accelerationVectorScratch[base + 2] = az;
              accelerationMagnitudeScratch[i] = Math.sqrt(ax * ax + ay * ay + az * az);
            }
          } else {
            accelerationVectorScratch.fill(0);
            accelerationMagnitudeScratch.fill(0);
          }

          const [accMin, accMax] = percentileRange(
            accelerationMagnitudeScratch,
            bodyCount,
            0.05,
            0.95,
            percentileScratch
          );
          const accSpan = Math.max(accMax - accMin, 1e-6);

          if (isResetOrRewind || latestAccelerationSpan <= 1e-6 || lastFrame < 0) {
            latestAccelerationMin = accMin;
            latestAccelerationSpan = accSpan;
          } else {
            const spanAlpha = Math.min(1.0, Math.max(0.05, frameIntervalMs / 250));
            const invSpanAlpha = 1 - spanAlpha;
            latestAccelerationMin = latestAccelerationMin * invSpanAlpha + accMin * spanAlpha;
            latestAccelerationSpan = latestAccelerationSpan * invSpanAlpha + accSpan * spanAlpha;
          }
        }

        bodyRadius = BODY_SPHERE_RADIUS;
        bodyInstances.setBodyRadius(bodyRadius);
        latestPositions = positions;
        latestVelocities = velocities;
        latestAccelerationVectors = accelerationVectorScratch;
        latestAccelerationMagnitudes = accelerationMagnitudeScratch;
        lastBodyUpdateCameraPos.copyFrom(camera.position);

        if (previousVelocitySnapshot.length !== velocities.length) {
          previousVelocitySnapshot = new Float32Array(velocities.length);
        }
        previousVelocitySnapshot.set(velocities);
        previousFrameSampleTime = lastFrameTime;
        lastFrame = frame;

        if (needsFit) {
          cameraRig.fitToBounds();
          needsFit = false;
        }
      }

      const anchorPositions =
        displayPositions.length === lastBodyCount * 3
          ? displayPositions
          : latestPositions;

      if (showVelocityVectors !== previousVelocityVectorsVisible) {
        if (showVelocityVectors) {
          if (
            anchorPositions
            && latestVelocities
            && renderedSpeeds.length === lastBodyCount
            && lastBodyCount > 0
          ) {
            vectorOverlays.update(
              'velocity',
              anchorPositions,
              latestVelocities,
              renderedSpeeds,
              lastBodyCount,
              latestSpeedMin,
              latestSpeedSpan,
              vectorScaleRadius
            );
          }
        } else {
          vectorOverlays.clear('velocity');
        }
      }
      previousVelocityVectorsVisible = showVelocityVectors;

      if (showAccelerationVectors !== previousAccelerationVectorsVisible) {
        if (showAccelerationVectors) {
          if (
            anchorPositions
            && latestAccelerationVectors
            && latestAccelerationMagnitudes
            && lastBodyCount > 0
          ) {
            vectorOverlays.update(
              'acceleration',
              anchorPositions,
              latestAccelerationVectors,
              latestAccelerationMagnitudes,
              lastBodyCount,
              latestAccelerationMin,
              latestAccelerationSpan,
              vectorScaleRadius
            );
          }
        } else {
          vectorOverlays.clear('acceleration');
        }
      }
      previousAccelerationVectorsVisible = showAccelerationVectors;

      const orbitTrailsVisibilityChanged = showOrbitTrails !== previousOrbitTrailsVisible;
      if (orbitTrailsVisibilityChanged) {
        if (!showOrbitTrails) {
          orbitTrails.clear();
        }
      }

      if (
        showOrbitTrails
        && anchorPositions
        && renderedSpeeds.length === lastBodyCount
        && lastBodyCount > 0
        && (frameChanged || displayPositionsChanged || colorsTransitioning || orbitTrailsVisibilityChanged)
      ) {
        orbitTrails.update(
          frame,
          anchorPositions,
          renderedSpeeds,
          lastBodyCount,
          latestSpeedMin,
          latestSpeedSpan
        );
      }
      previousOrbitTrailsVisible = showOrbitTrails;

      if (showWorldGrid !== previousWorldGridVisible) {
        worldGrid.setVisible(showWorldGrid);
      }
      previousWorldGridVisible = showWorldGrid;

      if (frameChanged || displayPositionsChanged || colorsTransitioning) {
        if (
          showVelocityVectors
          && anchorPositions
          && latestVelocities
          && renderedSpeeds.length === lastBodyCount
          && lastBodyCount > 0
        ) {
          vectorOverlays.update(
            'velocity',
            anchorPositions,
            latestVelocities,
            renderedSpeeds,
            lastBodyCount,
            latestSpeedMin,
            latestSpeedSpan,
            vectorScaleRadius
          );
        }

        if (
          showAccelerationVectors
          && anchorPositions
          && latestAccelerationVectors
          && latestAccelerationMagnitudes
          && lastBodyCount > 0
        ) {
          vectorOverlays.update(
            'acceleration',
            anchorPositions,
            latestAccelerationVectors,
            latestAccelerationMagnitudes,
            lastBodyCount,
            latestAccelerationMin,
            latestAccelerationSpan,
            vectorScaleRadius
          );
        }
      }

      cameraRig.update(dt);
      if (showWorldGrid) {
        worldGrid.update(camera.position);
      }

      // Refresh rendered positions and colors when interpolating at native viewport refresh rate.
      if (displayPositions.length > 0 && renderedSpeeds.length === lastBodyCount && lastBodyCount > 0) {
        const camDx = camera.position.x - lastBodyUpdateCameraPos.x;
        const camDy = camera.position.y - lastBodyUpdateCameraPos.y;
        const camDz = camera.position.z - lastBodyUpdateCameraPos.z;
        const cameraMovedSq = camDx * camDx + camDy * camDy + camDz * camDz;
        const cameraSignificantlyMoved = cameraMovedSq > 1e-4;

        // Adaptive VBO update throttle for subframe interpolation:
        // Always update immediately on a fresh simulation frame (frameChanged === true) or camera move.
        // For subframe display interpolation:
        // - High refresh rate screens (up to 144Hz) supported for clouds <= 15000 bodies.
        // - For massive clouds (> 15000, e.g. 30k Galaxy Collision): cap subframe uploads to ~70 FPS (14ms)
        //   to avoid saturating WebGL command queues while keeping subframe motion fluid.
        const minVboIntervalMs = lastBodyCount > 15000 ? 14 : 0;
        const timeSinceLastVbo = now - lastVboUploadTime;

        const shouldUploadVbo =
          frameChanged
          || cameraSignificantlyMoved
          || ((displayPositionsChanged || colorsTransitioning) && timeSinceLastVbo >= minVboIntervalMs);

        if (shouldUploadVbo) {
          const colorsDirty = frameChanged || cameraSignificantlyMoved || colorsTransitioning;
          bodyInstances.update(
            displayPositions,
            renderedSpeeds,
            lastBodyCount,
            latestSpeedMin,
            latestSpeedSpan,
            camera.position,
            BILLBOARD_SWITCH_DISTANCE * BILLBOARD_SWITCH_DISTANCE,
            colorsDirty
          );
          lastBodyUpdateCameraPos.copyFrom(camera.position);
          lastVboUploadTime = now;
        }
      }

      if (lastBodyCount > 0) {
        const distanceToCenter = Vector3.Distance(camera.position, boundsCenter);
        const cloudRadius = Math.max(boundsRadius, bodyRadius * 2);
        const closestBodyDistance = Math.max(distanceToCenter - cloudRadius, 0);
        const nextMinZ = Math.max(0.01, Math.min(5, closestBodyDistance * 0.2));
        const nextMaxZ = Math.max(10000, distanceToCenter + cloudRadius * 3 + 100);
        camera.minZ = nextMinZ;
        camera.maxZ = nextMaxZ;
      }

      scene.render();
    };

    engine.runRenderLoop(renderLoop);

    return () => {
      engine.stopRenderLoop(renderLoop);
      window.removeEventListener('resize', onResize);
      cameraRig.dispose();
      canvas.removeEventListener('contextmenu', preventContextMenu);
      bodyInstances.dispose();
      orbitTrails.dispose();
      worldGrid.dispose();
      vectorOverlays.dispose();
      wideGlowLayer?.dispose();
      renderingPipeline.dispose();
      scene.dispose();
      engine.dispose();
      if (host.contains(canvas)) host.removeChild(canvas);
    };
  }, []);

  return <div ref={hostRef} className="canvas-host" />;
});
