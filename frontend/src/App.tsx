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

const SIMULATION_PATH = '/sim';

function routeFromPathname(pathname: string): AppRoute {
  if (pathname === SIMULATION_PATH) {
    return 'simulation';
  }
  return 'landing';
}

function pathForRoute(route: AppRoute): string {
  return route === 'simulation' ? SIMULATION_PATH : '/';
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
    positions,
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
      positions: state.positions,
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
  const hasFirstFrame = positions !== null && bodyCount > 0;
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
  } else if (status === 'connected' && scenarioStartDispatched && !hasSimControlSnapshot) {
    loadingTitle = 'Synchronizing Controls';
    loadingDetail = 'Waiting for simulation control defaults from the backend.';
    loadingStatusLabel = 'Control Sync';
  } else if (status === 'connected' && scenarioStartDispatched) {
    loadingTitle = 'Loading Scenario';
    loadingDetail = 'Backend is generating and loading initial bodies. This may take a few seconds.';
    loadingStatusLabel = 'Scenario Startup';
  }

  const showLoadingOverlay = !hasFirstFrame || (!isMaster && !isSimRunning);
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
              The server&apos;s daily compute quota (1.5 cumulative hours) has been exhausted for today.
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

  const [socketControls, setSocketControls] = useState<SocketControls | null>(null);

  const { status, userRole, hasMaster, lastAuthError, hasReceivedAuthState, isServerFull, isLocallyHosted } = useFrameStore((state) => ({
    status: state.status,
    userRole: state.userRole,
    hasMaster: state.hasMaster,
    lastAuthError: state.lastAuthError,
    hasReceivedAuthState: state.hasReceivedAuthState,
    isServerFull: state.isServerFull,
    isLocallyHosted: state.isLocallyHosted
  }));

  const [isWaking, setIsWaking] = useState(false);
  const [wakeSecondsRemaining, setWakeSecondsRemaining] = useState(25);
  const [wakeStatusMessage, setWakeStatusMessage] = useState<string | null>(null);

  const wakeServer = useCallback(async () => {
    const wakeUrl = import.meta.env.VITE_WAKE_URL;
    if (!wakeUrl) return;
    setIsWaking(true);
    setWakeSecondsRemaining(25);
    setWakeStatusMessage('Requesting cluster boot...');

    try {
      await fetch(wakeUrl, { method: 'POST', mode: 'cors' });
      setWakeStatusMessage('Boot signal acknowledged. Starting simulation node...');
    } catch (err) {
      console.warn('Wakeup request dispatched:', err);
      setWakeStatusMessage('Boot signal dispatched. Waiting for cluster network...');
    }
  }, []);

  useEffect(() => {
    if (status === 'connected') {
      setIsWaking(false);
      setWakeSecondsRemaining(25);
      setWakeStatusMessage(null);
    }
  }, [status]);

  useEffect(() => {
    if (!isWaking) return;
    const interval = window.setInterval(() => {
      setWakeSecondsRemaining((prev) => {
        if (prev <= 1) {
          setIsWaking(false);
          socketControls?.reconnect();
          return 25;
        }
        if (prev <= 16 && prev % 3 === 0) {
          socketControls?.reconnect();
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isWaking, socketControls]);


  // Initialize and maintain root WebSocket connection
  useEffect(() => {
    const { pushFrame, setStatus, setSimControlSnapshot } = useFrameStore.getState();
    const controls = startFrameWebSocket(WS_URL, pushFrame, setStatus, setSimControlSnapshot);
    setSocketControls(controls);

    // Auto-reconnect as master if credentials saved in session
    const savedPwd = sessionStorage.getItem('nbody_master_pwd');
    const savedName = sessionStorage.getItem('nbody_master_name') || 'Master';
    if (savedPwd) {
      const timer = window.setTimeout(() => {
        controls.loginAsMaster(savedPwd, savedName);
      }, 120);
      return () => {
        window.clearTimeout(timer);
        setSocketControls(null);
        controls.close();
      };
    }

    return () => {
      setSocketControls(null);
      controls.close();
    };
  }, []);

  const handleMasterLogin = useCallback((password: string, name: string) => {
    sessionStorage.setItem('nbody_master_pwd', password);
    sessionStorage.setItem('nbody_master_name', name);
    return socketControls?.loginAsMaster(password, name) ?? false;
  }, [socketControls]);

  const handleMasterLogout = useCallback(() => {
    sessionStorage.removeItem('nbody_master_pwd');
    sessionStorage.removeItem('nbody_master_name');
    socketControls?.logoutMaster();
    useFrameStore.getState().setUserRole('spectator');
  }, [socketControls]);

  // If auth error occurred, clear saved credentials so we don't get stuck in a loop
  useEffect(() => {
    if (lastAuthError) {
      sessionStorage.removeItem('nbody_master_pwd');
      sessionStorage.removeItem('nbody_master_name');
    }
  }, [lastAuthError]);

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
  // "as a client, i should simply be taken to whatever is currently being simulated immediately rather than seeing the console landing page,
  // and only when there is no master should I be put in the console landing page."
  useEffect(() => {
    if (isLocallyHosted || userRole === 'master') {
      return; // Master or locally-hosted operator freely navigates between landing and simulation
    }

    if (hasMaster) {
      // Master is active: client immediately spectates whatever is being simulated!
      if (route !== 'simulation' || !isSpectating) {
        setIsSpectating(true);
        setActiveScenarioSelection(null);
        navigateToRoute('simulation');
      }
    } else {
      // No master is active: client is put in the console landing page!
      if (route !== 'landing' || isSpectating) {
        setIsSpectating(false);
        setActiveScenarioSelection(null);
        navigateToRoute('landing');
      }
    }
  }, [userRole, hasMaster, route, isSpectating, navigateToRoute]);

  const activeScenarioStartMessage = useMemo(() => {
    if (activeScenarioSelection === null) {
      return null;
    }
    return formatScenarioStartMessage(activeScenarioSelection);
  }, [activeScenarioSelection]);

  const handleStartSimulation = useCallback((selection: ScenarioSelection) => {
    setActiveScenarioSelection(selection);
    setIsSpectating(false);

    const frameStore = useFrameStore.getState();
    frameStore.reset();
    if (selection.kind === 'stable-orbits') {
      frameStore.setShowOrbitTrails(true);
    }

    setSimulationSessionToken((current) => current + 1);
    navigateToRoute('simulation');
  }, [navigateToRoute]);

  const handleBackToLanding = useCallback(() => {
    useFrameStore.getState().reset();
    setActiveScenarioSelection(null);
    setIsSpectating(false);
    navigateToRoute('landing');
  }, [navigateToRoute]);

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

  if (status === 'disconnected' || status === 'error') {
    const hasWakeUrl = Boolean(import.meta.env.VITE_WAKE_URL);

    return (
      <div className={appStyles.serverFullShell} role="alert" aria-live="assertive">
        <div className={appStyles.serverFullCard}>
          <div
            className={appStyles.serverFullIconWrapper}
            aria-hidden="true"
            style={hasWakeUrl ? { borderColor: 'rgba(56, 189, 248, 0.4)', background: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8' } : undefined}
          >
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
                <path d="M10 10 2.5 2.5" />
                <path d="M22 17v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h1" />
                <path d="M2 14h12" />
                <path d="M20 14h2" />
                <path d="M22 22 2 2" />
                <path d="M6 18h.01" />
                <path d="M7 6h.01" />
              </svg>
            )}
          </div>
          <h1 className={appStyles.serverFullTitle} style={hasWakeUrl ? { color: '#38bdf8' } : undefined}>
            {isWaking ? 'Booting Simulation Node' : (hasWakeUrl ? 'Simulation Node Standby' : 'Backend Disconnected')}
          </h1>
          <p className={appStyles.serverFullDescription}>
            {isWaking
              ? (wakeStatusMessage || 'Booting dedicated AWS compute node...')
              : (hasWakeUrl
                ? 'The simulation node is currently in standby to conserve AWS compute credits.'
                : 'The simulation backend is currently offline or unreachable.')}
          </p>
          <p className={appStyles.serverFullSubtext}>
            {isWaking
              ? `Estimated node readiness in ~${wakeSecondsRemaining}s. Connecting automatically...`
              : (hasWakeUrl
                ? 'Click below to spin up the dedicated compute node (~20 seconds).'
                : <>Please verify that the backend server is running (<code style={{ color: '#93c5fd' }}>./build/nbody_ws.exe</code>) to use the simulation.</>)}
          </p>
          {hasWakeUrl ? (
            <>
              <button
                className={appStyles.serverFullWakeBtn}
                type="button"
                disabled={isWaking}
                onClick={wakeServer}
              >
                {isWaking ? `Waking Node (${wakeSecondsRemaining}s)...` : '⚡ Wake Simulation Node (~20s)'}
              </button>
              <button
                className={appStyles.serverFullSecondaryBtn}
                type="button"
                onClick={() => socketControls?.reconnect()}
              >
                Manual Reconnect
              </button>
            </>
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

  if (status === 'connecting') {
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
