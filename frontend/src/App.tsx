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
  scenarioStartMessage: string;
  scenarioSelection: ScenarioSelection;
  onBackToLanding: () => void;
};

type SimulationLoadingOverlayProps = {
  title: string;
  detail: string;
  statusLabel: string;
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

function getScenarioTitle(selection: ScenarioSelection): string {
  switch (selection.kind) {
    case 'galaxy':
      return 'Galaxy';
    case 'galaxy-collision':
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
  onBackToLanding
}: SimulationLoadingOverlayProps) {
  return (
    <div className={appStyles.loadingOverlay} role="status" aria-live="polite">
      <div className={appStyles.loadingCard}>
        <div className={appStyles.loadingSpinner} aria-hidden="true" />
        <p className={appStyles.loadingStatusLabel}>{statusLabel}</p>
        <h2 className={appStyles.loadingTitle}>{title}</h2>
        <p className={appStyles.loadingDetail}>{detail}</p>
        <button
          className={appStyles.loadingBackButton}
          type="button"
          onClick={onBackToLanding}
        >
          Back To Landing
        </button>
      </div>
    </div>
  );
}

function SimulationPage({
  scenarioStartMessage,
  scenarioSelection,
  onBackToLanding
}: SimulationPageProps) {
  const {
    status,
    simPaused,
    simDt,
    hasSimControlSnapshot,
    bodyCount,
    positions
  } = useFrameStore(
    (state) => ({
      status: state.status,
      simPaused: state.simPaused,
      simDt: state.simDt,
      hasSimControlSnapshot: state.hasSimControlSnapshot,
      bodyCount: state.bodyCount,
      positions: state.positions
    }),
    shallow
  );

  const socketControlsRef = useRef<SocketControls | null>(null);
  const backToLandingTimeoutRef = useRef<number | null>(null);
  const backNavigationPendingRef = useRef(false);
  const scenarioStartSentRef = useRef(false);
  const [scenarioStartDispatched, setScenarioStartDispatched] = useState(false);
  const hasFirstFrame = positions !== null && bodyCount > 0;
  // Frames prove the backend has loaded a runnable simulation even if the control-state
  // snapshot text message was delayed or missed.
  const hasUsableSimControlState = hasSimControlSnapshot || hasFirstFrame;
  const controlsDisabled = status !== 'connected' || !hasUsableSimControlState;
  const useStableOrbitVisualTheme = scenarioSelection.kind === 'stable-orbits';
  const scenarioTitle = getScenarioTitle(scenarioSelection);

  const [virtualMove, setVirtualMove] = useState<VirtualMoveState>({ x: 0, y: 0 });
  const [viewportControlInsets, setViewportControlInsets] = useState<ViewportControlInsets>({
    bottom: 20,
    right: 20
  });

  useEffect(() => {
    const { pushFrame, setStatus, setSimControlSnapshot } = useFrameStore.getState();
    const controls = startFrameWebSocket(WS_URL, pushFrame, setStatus, setSimControlSnapshot);
    socketControlsRef.current = controls;
    return () => {
      if (backToLandingTimeoutRef.current !== null) {
        window.clearTimeout(backToLandingTimeoutRef.current);
      }
      // Pause on any simulation page exit (including browser/phone back navigation).
      controls.sendText('control:set?paused=1');
      socketControlsRef.current = null;
      controls.close();
    };
  }, []);

  useEffect(() => {
    scenarioStartSentRef.current = false;
    setScenarioStartDispatched(false);
  }, [scenarioStartMessage]);

  useEffect(() => {
    if (status !== 'connected') {
      scenarioStartSentRef.current = false;
      setScenarioStartDispatched(false);
      return;
    }

    if (scenarioStartSentRef.current) {
      return;
    }

    const sent = socketControlsRef.current?.sendText(scenarioStartMessage) ?? false;
    if (sent) {
      scenarioStartSentRef.current = true;
      setScenarioStartDispatched(true);
      socketControlsRef.current?.sendText('control:set?paused=0');
    }
  }, [scenarioStartMessage, status]);

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

  const showLoadingOverlay = !hasFirstFrame;
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
    return socketControlsRef.current?.sendText(message) ?? false;
  }, []);

  const handleBackToLandingRequest = useCallback(() => {
    if (backNavigationPendingRef.current) {
      return;
    }

    backNavigationPendingRef.current = true;
    const pauseSent = socketControlsRef.current?.sendText('control:set?paused=1') ?? false;

    if (!pauseSent) {
      onBackToLanding();
      backNavigationPendingRef.current = false;
      return;
    }

    backToLandingTimeoutRef.current = window.setTimeout(() => {
      onBackToLanding();
      backNavigationPendingRef.current = false;
      backToLandingTimeoutRef.current = null;
    }, 60);
  }, [onBackToLanding]);

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
          onBackToLanding={handleBackToLandingRequest}
        />
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

  useEffect(() => {
    const handlePopState = () => {
      setRoute(routeFromPathname(window.location.pathname));
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    if (route === 'simulation' && activeScenarioSelection === null) {
      navigateToRoute('landing', true);
    }
  }, [activeScenarioSelection, navigateToRoute, route]);

  useEffect(() => {
    if (route === 'landing' && activeScenarioSelection !== null) {
      setActiveScenarioSelection(null);
    }
  }, [activeScenarioSelection, route]);

  const activeScenarioStartMessage = useMemo(() => {
    if (activeScenarioSelection === null) {
      return null;
    }
    return formatScenarioStartMessage(activeScenarioSelection);
  }, [activeScenarioSelection]);

  useEffect(() => {
    if (route === 'simulation' && activeScenarioStartMessage === null) {
      navigateToRoute('landing', true);
    }
  }, [activeScenarioStartMessage, navigateToRoute, route]);

  const handleStartSimulation = useCallback((selection: ScenarioSelection) => {
    setActiveScenarioSelection(selection);

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
    navigateToRoute('landing');
  }, [navigateToRoute]);

  const showSimulationPage =
    route === 'simulation'
    && activeScenarioStartMessage !== null
    && activeScenarioSelection !== null;

  return (
    <div
      className={`${appStyles.appShell} ${showSimulationPage ? appStyles.simulationShell : ''}`.trim()}
    >
      {route === 'simulation'
      && activeScenarioStartMessage !== null
      && activeScenarioSelection !== null ? (
        <SimulationPage
          key={simulationSessionToken}
          scenarioStartMessage={activeScenarioStartMessage}
          scenarioSelection={activeScenarioSelection}
          onBackToLanding={handleBackToLanding}
        />
      ) : (
        <LandingPage
          formState={scenarioFormState}
          onFormStateChange={setScenarioFormState}
          onSimulate={handleStartSimulation}
        />
      )}
    </div>
  );
}
