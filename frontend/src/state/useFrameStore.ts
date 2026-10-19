import { create } from 'zustand';
import { ORBIT_TRAILS_ENABLED, WORLD_GRID_ENABLED } from '../lib/config';
import type { SimControlSnapshot } from '../lib/simControl';
import type { AuthState, UserRole } from '../lib/authControl';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type FramePayload = {
  frame: number;
  bodyCount: number;
  bodies: Float32Array;
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
  pushFrame: ({ frame, bodyCount, bodies, receivedAt, bytes }) => {
    const prev = get();
    const dt = receivedAt - prev.lastFrameTime;
    const fps = dt > 0 ? 1000 / dt : prev.fps;
    const valueCount = bodyCount * 3;

    let positions = prev.positions;
    if (!positions || positions.length !== valueCount) {
      positions = new Float32Array(valueCount);
    }

    let velocities = prev.velocities;
    if (!velocities || velocities.length !== valueCount) {
      velocities = new Float32Array(valueCount);
    }

    for (let bodyIndex = 0, positionIndex = 0, velocityIndex = 0; bodyIndex < bodyCount; bodyIndex += 1) {
      const sourceIndex = bodyIndex * 6;
      positions[positionIndex++] = bodies[sourceIndex];
      positions[positionIndex++] = bodies[sourceIndex + 1];
      positions[positionIndex++] = bodies[sourceIndex + 2];

      velocities[velocityIndex++] = bodies[sourceIndex + 3];
      velocities[velocityIndex++] = bodies[sourceIndex + 4];
      velocities[velocityIndex++] = bodies[sourceIndex + 5];
    }

    set({
      frame,
      bodyCount,
      positions,
      velocities,
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
  setAuthState: (partial: Partial<AuthState>) =>
    set((state) => ({
      ...state,
      ...partial,
      activeScenarioTitle: partial.scenario || state.activeScenarioTitle,
      hasReceivedAuthState: true
    })),
  setLastAuthError: (error: string | null) => set({ lastAuthError: error }),
  setIsServerFull: (isServerFull: boolean) => set({ isServerFull }),
  setActiveScenarioTitle: (activeScenarioTitle: string) => set({ activeScenarioTitle }),
  reset: () =>
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
    }))
}));
