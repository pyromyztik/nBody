import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { shallow } from 'zustand/shallow';
import appStyles from './App.module.css';
import {
  DEFAULT_SCENARIO_FORM_STATE,
  LandingPage,
  type ScenarioFormState
} from './components/landing/LandingPage';
import { MobileJoystick } from './components/hud/MobileJoystick';
import { HudPanel } from './components/hud/HudPanel';
import { SimControlDock } from './components/hud/SimControlDock';
import { ThreeNBody } from './graphics/ThreeNBody.tsx';
import {
  formatScenarioStartMessage,
  type ScenarioSelection
} from './lib/scenarioControl';
import {
  startFrameWebSocket,
  type SocketControls,
  WS_URL
} from './lib/socketStream';
import { useFrameStore } from './state/useFrameStore';

const JOYSTICK_RADIUS_PX = 44;

type VirtualMoveState = {
  x: number;
  y: number;
};

type ViewportControlInsets = {
  bottom: number;
  right: number;
};

type AppRoute = 'landing' | 'simulation';

type SimulationPageProps = {
  scenarioStartMessage: string | null;
  scenarioSelection: ScenarioSelection | null;
  socketControls: SocketControls | null;
  onBackToLanding: () => void;
};

type SimulationLoadingOverlayProps = {
  title: string;
  detail: string;
  statusLabel: string;
  showBackButton?: boolean;
  onBackToLanding: () => void;
};

const getBase = (): string => {
  const base = import.meta.env.BASE_URL || '/';
  return base.endsWith('/') ? base : `${base}/`;
};

const getSimulationPath = (): string => `${getBase()}sim`;
const getLandingPath = (): string => getBase();

function routeFromPathname(pathname: string): AppRoute {
  const simPath = getSimulationPath().replace(/\/+$/, '');
  const cleanPath = pathname.replace(/\/+$/, '');

  if (cleanPath === simPath || cleanPath.endsWith('/sim')) {
    return 'simulation';
  }
  return 'landing';
}

function pathForRoute(route: AppRoute): string {
  return route === 'simulation' ? getSimulationPath() : getLandingPath();
}

function resolveWakeUrl(): string | undefined {
  return import.meta.env.VITE_WAKE_URL || undefined;
}

function getScenarioTitle(selection: ScenarioSelection | null): string {
  if (!selection) return 'Live Simulation';
  switch (selection.kind) {
    case 'galaxy':
    case 'galaxy-10k':
      return 'Galaxy';
    case 'galaxy-collision':
    case 'galaxy-collision-15k':
      return 'Galaxy Collision';
    case 'stable-orbits':
      return 'Stable Orbits';
    case 'accretion-disk':
      return 'Accretion Disk';
    default:
      return 'Simulation';
  }
}

function SimulationLoadingOverlay({
  title,
  detail,
  statusLabel,
  showBackButton = true,
  onBackToLanding
}: SimulationLoadingOverlayProps) {
  return (
    <div className={appStyles.loadingOverlay} role="status" aria-live="polite">
      <div className={appStyles.loadingCard}>
        <div className={appStyles.loadingSpinner} aria-hidden="true" />
        <p className={appStyles.loadingStatusLabel}>{statusLabel}</p>
        <h2 className={appStyles.loadingTitle}>{title}</h2>
        <p className={appStyles.loadingDetail}>{detail}</p>
        {showBackButton && (
          <button
            className={appStyles.loadingBackButton}
            type="button"
            onClick={onBackToLanding}
          >
            Back To Landing
          </button>
        )}
      </div>
    </div>
  );
}

function SimulationPage({
  scenarioStartMessage,
  scenarioSelection,
  socketControls,
  onBackToLanding
}: SimulationPageProps) {
  const {
    status,
    simPaused,
    simDt,
    hasSimControlSnapshot,
    bodyCount,
    hasFirstFrame,
    isAwaitingNewScenario,
    userRole,
    hasMaster,
    masterName,
    isSimRunning,
    activeScenarioTitle,
    isComputeExhausted,
    isLocallyHosted
  } = useFrameStore(
    (state) => ({
      status: state.status,
      simPaused: state.simPaused,
      simDt: state.simDt,
      hasSimControlSnapshot: state.hasSimControlSnapshot,
      bodyCount: state.bodyCount,
      hasFirstFrame: state.positions !== null && state.bodyCount > 0,
      isAwaitingNewScenario: state.isAwaitingNewScenario,
      userRole: state.userRole,
      hasMaster: state.hasMaster,
      masterName: state.masterName,
      isSimRunning: state.isSimRunning,
      activeScenarioTitle: state.activeScenarioTitle,
      isComputeExhausted: state.isComputeExhausted,
      isLocallyHosted: state.isLocallyHosted
    }),
    shallow
  );

  const backToLandingTimeoutRef = useRef<number | null>(null);
  const backNavigationPendingRef = useRef(false);
  const scenarioStartSentRef = useRef(false);
  const [scenarioStartDispatched, setScenarioStartDispatched] = useState(false);
  const isMaster = userRole === 'master' || isLocallyHosted;

  // Frames prove the backend has loaded a runnable simulation even if the control-state
  // snapshot text message was delayed or missed.
  const hasUsableSimControlState = hasSimControlSnapshot || hasFirstFrame;
  const controlsDisabled = status !== 'connected' || !hasUsableSimControlState || !isMaster;
  const scenarioTitle = isMaster
    ? (getScenarioTitle(scenarioSelection) || activeScenarioTitle || 'Simulation')
    : (activeScenarioTitle || getScenarioTitle(scenarioSelection) || 'Simulation');
  const useStableOrbitVisualTheme =
    scenarioSelection?.kind === 'stable-orbits' || scenarioTitle === 'Stable Orbits';

  const [virtualMove, setVirtualMove] = useState<VirtualMoveState>({ x: 0, y: 0 });
  const [viewportControlInsets, setViewportControlInsets] = useState<ViewportControlInsets>({
    bottom: 20,
    right: 20
  });

  useEffect(() => {
    scenarioStartSentRef.current = false;
    setScenarioStartDispatched(false);
  }, [scenarioStartMessage]);

  useEffect(() => {
    // If we're a spectator (no scenarioStartMessage), we don't dispatch scenario start
    if (!scenarioStartMessage) {
      setScenarioStartDispatched(true);
      return;
    }

    if (status !== 'connected' || !isMaster || !socketControls) {
      scenarioStartSentRef.current = false;
      setScenarioStartDispatched(false);
      return;
    }

    if (scenarioStartSentRef.current) {
      return;
    }

    const sent = socketControls.sendText(scenarioStartMessage);
    if (sent) {
      scenarioStartSentRef.current = true;
      setScenarioStartDispatched(true);
      socketControls.sendText('control:set?paused=0');
    }
  }, [scenarioStartMessage, status, isMaster, socketControls]);

  let loadingTitle = 'Connecting To Backend';
  let loadingDetail = 'Opening a websocket connection to the simulation server.';
  let loadingStatusLabel = 'Network Setup';

  if (status === 'error') {
    loadingTitle = 'Backend Connection Failed';
    loadingDetail = 'Could not connect to the simulation server. Verify the backend is running and reachable.';
    loadingStatusLabel = 'Connection Error';
  } else if (status === 'disconnected') {
    loadingTitle = 'Backend Disconnected';
    loadingDetail = 'Connection to the simulation server was lost. Attempting to reconnect.';
    loadingStatusLabel = 'Reconnecting';
  } else if (!isMaster) {
    if (hasMaster) {
      if (!isSimRunning) {
        loadingTitle = 'Waiting for Master';
        loadingDetail = `Master (${masterName || 'Master'}) is configuring a new scenario in the console.`;
        loadingStatusLabel = 'Awaiting Simulation';
      } else {
        loadingTitle = 'Connecting to Master Stream';
        loadingDetail = `Spectating live simulation commanded by ${masterName || 'Master'}. Waiting for physics data...`;
        loadingStatusLabel = 'Live Stream';
      }
    } else {
      loadingTitle = 'Waiting for Master';
      loadingDetail = 'No Master is currently running a simulation. You can claim the Master role to launch one.';
      loadingStatusLabel = 'Awaiting Master';
    }
  } else if (status === 'connected' && !scenarioStartDispatched) {
    loadingTitle = 'Preparing Scenario Request';
    loadingDetail = 'Sending selected scenario parameters to the backend.';
    loadingStatusLabel = 'Request Setup';
  } else if (status === 'connected') {
    loadingTitle = 'Loading Scenario';
    loadingDetail = 'Backend is generating and loading initial bodies. This may take a few seconds.';
    loadingStatusLabel = 'Scenario Startup';
  }

  const showLoadingOverlay = !hasFirstFrame || isAwaitingNewScenario || (!isMaster && !isSimRunning);
  const showPausedVignette = simPaused && !showLoadingOverlay;

  useEffect(() => {
    const visualViewport = window.visualViewport;

    const updateViewportControlInsets = () => {
      const root = document.documentElement;
      const layoutWidth = root.clientWidth || window.innerWidth;
      const layoutHeight = root.clientHeight || window.innerHeight;

      if (!visualViewport) {
        setViewportControlInsets({ bottom: 20, right: 20 });
        return;
      }

      const rightInset = Math.max(
        0,
        Math.ceil(layoutWidth - (visualViewport.offsetLeft + visualViewport.width))
      );
      const bottomInset = Math.max(
        0,
        Math.ceil(layoutHeight - (visualViewport.offsetTop + visualViewport.height))
      );

      setViewportControlInsets({
        bottom: 20 + bottomInset,
        right: 20 + rightInset
      });
    };

    updateViewportControlInsets();
    window.addEventListener('resize', updateViewportControlInsets);
    visualViewport?.addEventListener('resize', updateViewportControlInsets);
    visualViewport?.addEventListener('scroll', updateViewportControlInsets);

    return () => {
      window.removeEventListener('resize', updateViewportControlInsets);
      visualViewport?.removeEventListener('resize', updateViewportControlInsets);
      visualViewport?.removeEventListener('scroll', updateViewportControlInsets);
    };
  }, []);

  const sendControlMessage = useCallback((message: string): boolean => {
    if (!isMaster) return false;
    return socketControls?.sendText(message) ?? false;
  }, [isMaster, socketControls]);

  const handleBackToLandingRequest = useCallback(() => {
    if (backNavigationPendingRef.current) {
      return;
    }

    backNavigationPendingRef.current = true;

    // Master returns to console: tell the backend simulation is stopped
    if (isMaster) {
      socketControls?.sendText('sim:console');
    }

    onBackToLanding();
    backNavigationPendingRef.current = false;
  }, [isMaster, onBackToLanding, socketControls]);

  const handleVirtualMoveChange = useCallback((x: number, y: number) => {
    setVirtualMove({ x, y });
  }, []);

  return (
    <div className={appStyles.appShell}>
      <ThreeNBody
        virtualMoveX={virtualMove.x}
        virtualMoveY={virtualMove.y}
        renderTheme={useStableOrbitVisualTheme ? 'stable-orbits' : 'default'}
      />
      <div
        className={`${appStyles.pauseVignette} ${showPausedVignette ? appStyles.pauseVignetteVisible : ''}`.trim()}
        aria-hidden="true"
      />
      <HudPanel
        scenarioTitle={scenarioTitle}
        status={status}
        wsUrl={WS_URL}
        controlsDisabled={controlsDisabled}
        onSendControlMessage={sendControlMessage}
        onBackToLanding={handleBackToLandingRequest}
      />
      <SimControlDock
        controlsDisabled={controlsDisabled}
        simPaused={simPaused}
        simDt={simDt}
        onSendControlMessage={sendControlMessage}
      />
      <MobileJoystick
        radiusPx={JOYSTICK_RADIUS_PX}
        bottomInsetPx={viewportControlInsets.bottom}
        rightInsetPx={viewportControlInsets.right}
        onMoveChange={handleVirtualMoveChange}
      />
      {showLoadingOverlay && (
        <SimulationLoadingOverlay
          title={loadingTitle}
          detail={loadingDetail}
          statusLabel={loadingStatusLabel}
          showBackButton={isMaster}
          onBackToLanding={handleBackToLandingRequest}
        />
      )}
      {!isLocallyHosted && isComputeExhausted && (
        <div className={appStyles.quotaModalShell} role="alert" aria-live="assertive">
          <div className={appStyles.quotaModalCard}>
            <div className={appStyles.quotaModalIcon} aria-hidden="true">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h2 className={appStyles.quotaModalTitle}>Daily Compute Limit Reached</h2>
            <p className={appStyles.quotaModalDesc}>
              The server&apos;s daily compute quota (1 cumulative hour) has been exhausted for today.
            </p>
            <p className={appStyles.quotaModalSubtext}>
              Active physics simulation has been paused. Please return tomorrow to continue using the simulator.
            </p>
            <button
              className={appStyles.quotaModalButton}
              type="button"
              onClick={handleBackToLandingRequest}
            >
              Back to Console
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState<AppRoute>(() => routeFromPathname(window.location.pathname));
  const [scenarioFormState, setScenarioFormState] =
    useState<ScenarioFormState>(DEFAULT_SCENARIO_FORM_STATE);
  const [activeScenarioSelection, setActiveScenarioSelection] =
    useState<ScenarioSelection | null>(null);
  const [isSpectating, setIsSpectating] = useState(false);
  const [simulationSessionToken, setSimulationSessionToken] = useState(0);

  const navigateToRoute = useCallback((nextRoute: AppRoute, replace = false) => {
    const nextPath = pathForRoute(nextRoute);
    if (window.location.pathname !== nextPath) {
      if (replace) {
        window.history.replaceState({}, '', nextPath);
      } else {
        window.history.pushState({}, '', nextPath);
      }
    }
    setRoute(nextRoute);
  }, []);

  const [socketControls, setSocketControls] = useState<SocketControls | null>(null);

  const { status, userRole, hasMaster, lastAuthError, hasReceivedAuthState, isServerFull, isLocallyHosted, isSimRunning } = useFrameStore(
    (state) => ({
      status: state.status,
      userRole: state.userRole,
      hasMaster: state.hasMaster,
      lastAuthError: state.lastAuthError,
      hasReceivedAuthState: state.hasReceivedAuthState,
      isServerFull: state.isServerFull,
      isLocallyHosted: state.isLocallyHosted,
      isSimRunning: state.isSimRunning
    }),
    shallow
  );

  const [isWaking, setIsWaking] = useState(false);
  const [wakeStatusMessage, setWakeStatusMessage] = useState<string | null>(null);

  // Fast standby probe on initial mount if wake URL is configured
  useEffect(() => {
    const wakeUrl = resolveWakeUrl();
    if (!wakeUrl || status === 'connected') return;

    let active = true;
    fetch(wakeUrl, { method: 'GET', mode: 'cors' })
      .then((res) => res.json())
      .then((data: { status?: string; state?: string }) => {
        if (!active) return;
        if (data.status === 'stopped' || data.state === 'stopped') {
          // Dedicated instance is stopped: immediately update status so standby screen renders without delay
          if (useFrameStore.getState().status !== 'connected') {
            useFrameStore.getState().setStatus('disconnected');
          }
        }
      })
      .catch(() => {
        // Ignore fetch errors, WebSocket 3s timeout handles fallback
      });

    return () => {
      active = false;
    };
  }, []);

  const wakeServer = useCallback(async () => {
    const wakeUrl = resolveWakeUrl();
    if (!wakeUrl) return;
    setIsWaking(true);
    setWakeStatusMessage('Starting simulation node. Connecting automatically once online...');

    try {
      await fetch(wakeUrl, { method: 'POST', mode: 'cors' });
    } catch (err) {
      console.warn('Wakeup request dispatched:', err);
    }
  }, []);

  useEffect(() => {
    if (status === 'connected') {
      setIsWaking(false);
      setWakeStatusMessage(null);
    }
  }, [status]);

  useEffect(() => {
    if (!isWaking) return;
    // Automatically poll and reconnect every 3s while booting until connected
    const interval = window.setInterval(() => {
      if (useFrameStore.getState().status === 'connected') {
        setIsWaking(false);
        setWakeStatusMessage(null);
        return;
      }
      socketControls?.reconnect();
    }, 3000);
    return () => window.clearInterval(interval);
  }, [isWaking, socketControls]);


  // Initialize and maintain root WebSocket connection
  useEffect(() => {
    const { pushFrame, setStatus, setSimControlSnapshot } = useFrameStore.getState();
    const controls = startFrameWebSocket(WS_URL, pushFrame, setStatus, setSimControlSnapshot);
    setSocketControls(controls);

    return () => {
      setSocketControls(null);
      controls.close();
    };
  }, []);

  const handleMasterLogin = useCallback((password: string, name: string) => {
    sessionStorage.setItem('nbody_master_pwd', password);
    sessionStorage.setItem('nbody_master_name', name);
    useFrameStore.getState().setUserRole('pending');
    return socketControls?.loginAsMaster(password, name) ?? false;
  }, [socketControls]);

  const handleMasterLogout = useCallback(() => {
    sessionStorage.removeItem('nbody_master_pwd');
    sessionStorage.removeItem('nbody_master_name');
    socketControls?.sendText('sim:console');
    socketControls?.logoutMaster();
    useFrameStore.getState().setUserRole('spectator');
    useFrameStore.getState().reset();
    setActiveScenarioSelection(null);
    setIsSpectating(false);
    navigateToRoute('landing', true);
  }, [socketControls, navigateToRoute]);

  // If an invalid password error occurred, clear saved credentials
  useEffect(() => {
    if (lastAuthError && (lastAuthError.toLowerCase().includes('incorrect') || lastAuthError.toLowerCase().includes('invalid password'))) {
      sessionStorage.removeItem('nbody_master_pwd');
      sessionStorage.removeItem('nbody_master_name');
    }
  }, [lastAuthError]);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(routeFromPathname(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  // Auto-routing for clients/spectators:
  // As a spectator/client, only navigate to live simulation if a simulation is actually active.
  // When no simulation is running or when operator is in console, stay on console landing page.
  useEffect(() => {
    const hasMasterCredentials = Boolean(sessionStorage.getItem('nbody_master_pwd'));
    if (isLocallyHosted || userRole === 'master' || userRole === 'pending' || hasMasterCredentials) {
      return; // Master or authenticating operator freely navigates between landing and simulation
    }

    if (hasMaster && isSimRunning) {
      // Live simulation is active: spectator immediately views whatever is being simulated!
      if (route !== 'simulation' || !isSpectating) {
        setIsSpectating(true);
        setActiveScenarioSelection(null);
        navigateToRoute('simulation');
      }
    } else {
      // No active simulation or no master: spectator is put in the console landing page!
      if (route !== 'landing' && isSpectating) {
        setIsSpectating(false);
        setActiveScenarioSelection(null);
        navigateToRoute('landing');
      }
    }
  }, [userRole, hasMaster, isSimRunning, route, isSpectating, navigateToRoute]);

  // Auto-redirect if user reloaded or navigated to /sim but there is no running simulation and no active selection
  useEffect(() => {
    if (!hasReceivedAuthState) return;
    if (route === 'simulation' && !isSimRunning && activeScenarioSelection === null && userRole !== 'master' && userRole !== 'pending') {
      navigateToRoute('landing', true);
    }
  }, [hasReceivedAuthState, route, isSimRunning, activeScenarioSelection, userRole, navigateToRoute]);

  const activeScenarioStartMessage = useMemo(() => {
    if (activeScenarioSelection === null) {
      return null;
    }
    return formatScenarioStartMessage(activeScenarioSelection);
  }, [activeScenarioSelection]);

  const handleStartSimulation = useCallback((selection: ScenarioSelection) => {
    setActiveScenarioSelection(selection);
    setIsSpectating(false);

    let expectedBodies = 0;
    if (selection.kind === 'galaxy') expectedBodies = 30000;
    else if (selection.kind === 'galaxy-10k') expectedBodies = 10000;
    else if (selection.kind === 'galaxy-collision') expectedBodies = 30000;
    else if (selection.kind === 'galaxy-collision-15k') expectedBodies = 15000;
    else if (selection.kind === 'stable-orbits' || selection.kind === 'accretion-disk') {
      expectedBodies = selection.bodyCount;
    }

    const frameStore = useFrameStore.getState();
    frameStore.reset();
    frameStore.setAwaitingNewScenario(true, expectedBodies);
    if (selection.kind === 'stable-orbits') {
      frameStore.setShowOrbitTrails(true);
    }

    setSimulationSessionToken((current) => current + 1);
    navigateToRoute('simulation');
  }, [navigateToRoute]);

  const handleBackToLanding = useCallback(() => {
    socketControls?.sendText('sim:console');
    useFrameStore.getState().reset();
    setActiveScenarioSelection(null);
    setIsSpectating(false);
    navigateToRoute('landing');
  }, [socketControls, navigateToRoute]);

  const showSimulationPage =
    route === 'simulation' && (isSpectating || activeScenarioSelection !== null);

  if (isServerFull) {
    return (
      <div className={appStyles.serverFullShell} role="alert" aria-live="assertive">
        <div className={appStyles.serverFullCard}>
          <div className={appStyles.serverFullIconWrapper} aria-hidden="true">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <path d="M16 3.128a4 4 0 0 1 0 7.744" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <circle cx="9" cy="7" r="4" />
            </svg>
          </div>
          <h1 className={appStyles.serverFullTitle}>Server is Full</h1>
          <p className={appStyles.serverFullDescription}>
            The simulation is currently operating at maximum capacity (1 Master + 6 Spectators).
          </p>
          <p className={appStyles.serverFullSubtext}>
            All spectator slots are occupied. Please wait for an open slot and try again.
          </p>
          <button
            className={appStyles.serverFullRetryBtn}
            type="button"
            onClick={() => {
              useFrameStore.getState().setIsServerFull(false);
              socketControls?.reconnect();
            }}
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  if (isWaking || ((status === 'disconnected' || status === 'error') && route === 'landing')) {
    const hasWakeUrl = Boolean(resolveWakeUrl());

    return (
      <div className={appStyles.serverFullShell} role="alert" aria-live="assertive">
        <div className={appStyles.serverFullCard}>
          <div className={appStyles.serverFullIconWrapper} aria-hidden="true">
            {isWaking ? (
              <div className={appStyles.loadingSpinner} style={{ width: 32, height: 32, borderWidth: 3 }} />
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M7 2h13a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-5" />
                <path d="M10 10 2.5 2.5C2 2 2 2.5 2 5v3a2 2 0 0 0 2 2h6z" />
                <path d="M22 17v-1a2 2 0 0 0-2-2h-1" />
                <path d="M4 14a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16.5l1-.5.5.5-8-8H4z" />
                <path d="M6 18h.01" />
                <path d="m2 2 20 20" />
              </svg>
            )}
          </div>
          <h1 className={appStyles.serverFullTitle}>
            {isWaking ? 'Booting Simulation Node' : (hasWakeUrl ? 'Simulation Node in Standby' : 'Backend Disconnected')}
          </h1>
          <p className={appStyles.serverFullDescription}>
            {isWaking
              ? (wakeStatusMessage || 'Starting dedicated compute node. Connecting automatically once online...')
              : (hasWakeUrl
                ? 'The simulation node is currently in standby to conserve AWS compute credits.'
                : 'The simulation backend is currently offline or unreachable.')}
          </p>
          {!isWaking && (
            <p className={appStyles.serverFullSubtext}>
              {hasWakeUrl
                ? 'Click below to spin up the dedicated compute node.'
                : <>Please verify that the backend server is running (<code style={{ color: '#93c5fd' }}>./build/nbody_ws.exe</code>) to use the simulation.</>}
            </p>
          )}
          {hasWakeUrl ? (
            <button
              className={appStyles.serverFullWakeBtn}
              type="button"
              disabled={isWaking}
              onClick={wakeServer}
            >
              {isWaking ? 'Waking Node...' : 'Wake Simulation Node'}
            </button>
          ) : (
            <button
              className={appStyles.serverFullRetryBtn}
              type="button"
              onClick={() => {
                socketControls?.reconnect();
              }}
            >
              Retry Connection
            </button>
          )}
        </div>
      </div>
    );
  }

  if (status === 'connecting' && !isWaking && route === 'landing') {
    return (
      <div className={appStyles.serverFullShell} role="status" aria-live="polite">
        <div className={appStyles.serverFullCard}>
          <div className={appStyles.loadingSpinner} aria-hidden="true" style={{ width: 44, height: 44, marginBottom: 20 }} />
          <h1 className={appStyles.serverFullTitle} style={{ color: '#e2e8f0', fontSize: '1.8rem' }}>Connecting</h1>
          <p className={appStyles.serverFullDescription}>
            Connecting to simulation backend...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${appStyles.appShell} ${showSimulationPage ? appStyles.simulationShell : ''}`.trim()}
    >
      {showSimulationPage ? (
        <SimulationPage
          key={simulationSessionToken}
          scenarioStartMessage={activeScenarioStartMessage}
          scenarioSelection={activeScenarioSelection}
          socketControls={socketControls}
          onBackToLanding={handleBackToLanding}
        />
      ) : (
        <LandingPage
          formState={scenarioFormState}
          onFormStateChange={setScenarioFormState}
          onSimulate={handleStartSimulation}
          onMasterLogin={handleMasterLogin}
          onMasterLogout={handleMasterLogout}
          authErrorMessage={lastAuthError}
        />
      )}
    </div>
  );
}
