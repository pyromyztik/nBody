import { create } from 'zustand';
import { ORBIT_TRAILS_ENABLED, WORLD_GRID_ENABLED } from '../lib/config';
import type { SimControlSnapshot } from '../lib/simControl';
import type { AuthState, UserRole } from '../lib/authControl';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type FramePayload = {
  frame: number;
  bodyCount: number;
  simDt: number;
  minX: number;
  minY: number;
  minZ: number;
  extentX: number;
  extentY: number;
  extentZ: number;
  bodies: Uint16Array;
  receivedAt: number;
  bytes: number;
};

export type FrameState = {
  frame: number;
  bodyCount: number;
  positions: Float32Array | null;
  velocities: Float32Array | null;
  fps: number;
  status: ConnectionStatus;
  totalBytes: number;
  lastFrameTime: number;
  showVelocityVectors: boolean;
  showAccelerationVectors: boolean;
  showOrbitTrails: boolean;
  showWorldGrid: boolean;
  invertLook: boolean;
  cameraBaseMoveSpeed: number;
  simPaused: boolean;
  simDt: number;
  simDefaultDt: number;
  hasSimControlSnapshot: boolean;
  userRole: UserRole;
  hasMaster: boolean;
  masterName: string;
  spectatorCount: number;
  maxSpectators: number;
  isSimRunning: boolean;
  lastAuthError: string | null;
  hasReceivedAuthState: boolean;
  activeScenarioTitle: string;
  isServerFull: boolean;
  usedComputeSeconds: number;
  maxComputeSeconds: number;
  computeRemainingSeconds: number;
  isComputeExhausted: boolean;
  isLoginLocked: boolean;
  remainingLoginAttempts: number;
  isLocallyHosted: boolean;
};

export type FrameActions = {
  pushFrame: (payload: FramePayload) => void;
  setStatus: (status: ConnectionStatus) => void;
  setShowVelocityVectors: (show: boolean) => void;
  setShowAccelerationVectors: (show: boolean) => void;
  setShowOrbitTrails: (show: boolean) => void;
  setShowWorldGrid: (show: boolean) => void;
  setInvertLook: (invert: boolean) => void;
  setCameraBaseMoveSpeed: (speed: number) => void;
  setSimControlSnapshot: (snapshot: SimControlSnapshot) => void;
  setUserRole: (role: UserRole) => void;
  setIsLocallyHosted: (isLocallyHosted: boolean) => void;
  setAuthState: (state: Partial<AuthState>) => void;
  setLastAuthError: (error: string | null) => void;
  setIsServerFull: (isFull: boolean) => void;
  setActiveScenarioTitle: (title: string) => void;
  reset: () => void;
};

const DEFAULT_SIM_CONTROL_STATE: SimControlSnapshot = {
  paused: false,
  dt: 0.016667,
  defaultDt: 0.016667
};

let positionBuffers: [Float32Array, Float32Array, Float32Array] = [
  new Float32Array(0),
  new Float32Array(0),
  new Float32Array(0)
];
let historyFrames: [number, number, number] = [-1, -1, -1];
let activeBufferIdx = 0;
let velocityFilterInitialized = false;

let fpsWindowStart = performance.now();
let fpsWindowFrameCount = 0;
let currentFps = 0;

function resetPositionHistory() {
  historyFrames = [-1, -1, -1];
  velocityFilterInitialized = false;
  fpsWindowStart = performance.now();
  fpsWindowFrameCount = 0;
  currentFps = 0;
}

export const useFrameStore = create<FrameState & FrameActions>((set, get) => ({
  frame: 0,
  bodyCount: 0,
  positions: null,
  velocities: null,
  fps: 0,
  status: 'connecting',
  totalBytes: 0,
  lastFrameTime: performance.now(),
  showVelocityVectors: false,
  showAccelerationVectors: false,
  showOrbitTrails: ORBIT_TRAILS_ENABLED,
  showWorldGrid: WORLD_GRID_ENABLED,
  invertLook: false,
  cameraBaseMoveSpeed: 300,
  simPaused: DEFAULT_SIM_CONTROL_STATE.paused,
  simDt: DEFAULT_SIM_CONTROL_STATE.dt,
  simDefaultDt: DEFAULT_SIM_CONTROL_STATE.defaultDt,
  hasSimControlSnapshot: false,
  userRole: 'spectator',
  hasMaster: false,
  masterName: '',
  spectatorCount: 0,
  maxSpectators: 6,
  isSimRunning: false,
  lastAuthError: null,
  hasReceivedAuthState: false,
  activeScenarioTitle: 'Galaxy',
  isServerFull: false,
  usedComputeSeconds: 0,
  maxComputeSeconds: 3600,
  computeRemainingSeconds: 3600,
  isComputeExhausted: false,
  isLoginLocked: false,
  remainingLoginAttempts: 5,
  isLocallyHosted: false,
  pushFrame: ({
    frame,
    bodyCount,
    simDt,
    minX,
    minY,
    minZ,
    extentX,
    extentY,
    extentZ,
    bodies,
    receivedAt,
    bytes
  }) => {
    const prev = get();
    fpsWindowFrameCount += 1;
    const windowElapsed = receivedAt - fpsWindowStart;
    if (windowElapsed >= 500) {
      const instantFps = Math.min(240, Math.round((fpsWindowFrameCount * 1000) / windowElapsed));
      currentFps = currentFps > 0 ? Math.round(currentFps * 0.6 + instantFps * 0.4) : instantFps;
      fpsWindowStart = receivedAt;
      fpsWindowFrameCount = 0;
    }
    const fps = currentFps > 0 ? currentFps : (prev.fps > 0 ? prev.fps : 60);
    const valueCount = bodyCount * 3;

    if (positionBuffers[0].length !== valueCount) {
      positionBuffers = [
        new Float32Array(valueCount),
        new Float32Array(valueCount),
        new Float32Array(valueCount)
      ];
      resetPositionHistory();
      activeBufferIdx = 0;
    }

    const currentPositions = positionBuffers[activeBufferIdx];

    const inv65535 = 1 / 65535;
    const scaleX = extentX * inv65535;
    const scaleY = extentY * inv65535;
    const scaleZ = extentZ * inv65535;

    for (let i = 0, j = 0; i < bodyCount; i++, j += 3) {
      currentPositions[j] = minX + bodies[j] * scaleX;
      currentPositions[j + 1] = minY + bodies[j + 1] * scaleY;
      currentPositions[j + 2] = minZ + bodies[j + 2] * scaleZ;
    }

    let velocities = prev.velocities;
    if (!velocities || velocities.length !== valueCount) {
      velocities = new Float32Array(valueCount);
      velocityFilterInitialized = false;
    }

    const idxPrev1 = (activeBufferIdx + 2) % 3;
    const idxPrev2 = (activeBufferIdx + 1) % 3;
    const framePrev1 = historyFrames[idxPrev1];
    const framePrev2 = historyFrames[idxPrev2];
    const posPrev1 = positionBuffers[idxPrev1];
    const posPrev2 = positionBuffers[idxPrev2];

    const isConsecutive1 =
      framePrev1 >= 0 &&
      frame > framePrev1 &&
      bodyCount === prev.bodyCount &&
      posPrev1.length === valueCount;

    const isConsecutive2 =
      isConsecutive1 &&
      framePrev2 >= 0 &&
      framePrev1 > framePrev2 &&
      posPrev2.length === valueCount;

    const activeSimDt = simDt > 0 ? simDt : (prev.simDt > 0 ? prev.simDt : 0.016667);

    if (isConsecutive1) {
      const frameDelta1 = frame - framePrev1;
      const effectiveDt1 = frameDelta1 * activeSimDt;

      // When 2 past frames are available, 2-step central/backward difference doubles
      // the baseline and halves single-step integer quantization roundoff noise.
      if (isConsecutive2) {
        const frameDelta2 = frame - framePrev2;
        const effectiveDt2 = frameDelta2 * activeSimDt;
        const invDt2 = effectiveDt2 > 1e-6 ? 1 / effectiveDt2 : 0;

        // Continuous-time exponential moving average with tau = 35ms.
        // At 240 FPS (Figure-8), this filters out single-frame roundoff jitter
        // while tracking real trajectory curvature without perceptible lag.
        const alpha = Math.min(1.0, Math.max(0.08, 1 - Math.exp(-effectiveDt1 / 0.035)));

        if (!velocityFilterInitialized) {
          for (let i = 0; i < valueCount; i++) {
            velocities[i] = (currentPositions[i] - posPrev2[i]) * invDt2;
          }
          velocityFilterInitialized = true;
        } else {
          const invAlpha = 1 - alpha;
          for (let i = 0; i < valueCount; i++) {
            const rawVel = (currentPositions[i] - posPrev2[i]) * invDt2;
            velocities[i] = velocities[i] * invAlpha + rawVel * alpha;
          }
        }
      } else {
        const invDt1 = effectiveDt1 > 1e-6 ? 1 / effectiveDt1 : 0;
        for (let i = 0; i < valueCount; i++) {
          velocities[i] = (currentPositions[i] - posPrev1[i]) * invDt1;
        }
        velocityFilterInitialized = true;
      }
    } else {
      velocities.fill(0);
      resetPositionHistory();
    }

    historyFrames[activeBufferIdx] = frame;
    activeBufferIdx = (activeBufferIdx + 1) % 3;

    set({
      frame,
      bodyCount,
      positions: currentPositions,
      velocities,
      simDt: activeSimDt,
      fps,
      lastFrameTime: receivedAt,
      totalBytes: prev.totalBytes + bytes
    });
  },
  setStatus: (status: ConnectionStatus) =>
    set((state) => {
      if (status === 'connected') {
        return {
          status,
          hasSimControlSnapshot: state.hasSimControlSnapshot
        };
      }

      resetPositionHistory();
      return {
        status,
        frame: 0,
        bodyCount: 0,
        positions: null,
        velocities: null,
        fps: 0,
        totalBytes: 0,
        lastFrameTime: performance.now(),
        simPaused: DEFAULT_SIM_CONTROL_STATE.paused,
        simDt: DEFAULT_SIM_CONTROL_STATE.dt,
        simDefaultDt: DEFAULT_SIM_CONTROL_STATE.defaultDt,
        hasSimControlSnapshot: false
      };
    }),
  setShowVelocityVectors: (show: boolean) => set({ showVelocityVectors: show }),
  setShowAccelerationVectors: (show: boolean) => set({ showAccelerationVectors: show }),
  setShowOrbitTrails: (show: boolean) => set({ showOrbitTrails: show }),
  setShowWorldGrid: (show: boolean) => set({ showWorldGrid: show }),
  setInvertLook: (invert: boolean) => set({ invertLook: invert }),
  setCameraBaseMoveSpeed: (speed: number) =>
    set({
      cameraBaseMoveSpeed: Number.isFinite(speed) ? Math.max(10, Math.min(1_000_000, speed)) : 300
    }),
  setSimControlSnapshot: (snapshot: SimControlSnapshot) =>
    set({
      simPaused: snapshot.paused,
      simDt: snapshot.dt,
      simDefaultDt: snapshot.defaultDt,
      hasSimControlSnapshot: true
    }),
  setUserRole: (role: UserRole) => set({ userRole: role }),
  setIsLocallyHosted: (isLocallyHosted: boolean) => set({ isLocallyHosted }),
  setAuthState: (partial: Partial<AuthState>) =>
    set((state) => {
      const isLocallyHosted = partial.locallyHosted ?? state.isLocallyHosted;
      const userRole = isLocallyHosted ? 'master' : (partial.hasMaster && state.userRole !== 'master' ? 'spectator' : state.userRole);
      return {
        ...state,
        ...partial,
        isLocallyHosted,
        userRole,
        activeScenarioTitle: partial.scenario || state.activeScenarioTitle,
        hasReceivedAuthState: true
      };
    }),
  setLastAuthError: (error: string | null) => set({ lastAuthError: error }),
  setIsServerFull: (isServerFull: boolean) => set({ isServerFull }),
  setActiveScenarioTitle: (activeScenarioTitle: string) => set({ activeScenarioTitle }),
  reset: () => {
    resetPositionHistory();
    set((state) => ({
      frame: 0,
      bodyCount: 0,
      positions: null,
      velocities: null,
      fps: 0,
      status: state.status,
      totalBytes: 0,
      lastFrameTime: performance.now(),
      showVelocityVectors: false,
      showAccelerationVectors: false,
      showOrbitTrails: ORBIT_TRAILS_ENABLED,
      showWorldGrid: WORLD_GRID_ENABLED,
      invertLook: false,
      cameraBaseMoveSpeed: 300,
      simPaused: DEFAULT_SIM_CONTROL_STATE.paused,
      simDt: DEFAULT_SIM_CONTROL_STATE.dt,
      simDefaultDt: DEFAULT_SIM_CONTROL_STATE.defaultDt,
      hasSimControlSnapshot: false
    }));
  }
}));
