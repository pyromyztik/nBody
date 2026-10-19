import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from 'react';
import {
  STABLE_ORBIT_FAMILIES,
  deriveAccretionDiskRadiusFromBodyCount,
  type ScenarioKind,
  type ScenarioSelection,
  type StableOrbitFamily,
  validateScenarioSelection
} from '../../lib/scenarioControl';
import { useFrameStore } from '../../state/useFrameStore';
import styles from './LandingPage.module.css';

export type PrimaryScenarioKind =
  | 'galaxy'
  | 'galaxy-collision'
  | 'stable-orbits'
  | 'accretion-disk';

export type GalaxyVariant = '10k' | '30k';
export type GalaxyCollisionVariant = '15k' | '30k';

type ScenarioFormState = {
  kind: PrimaryScenarioKind;
  galaxyVariant: GalaxyVariant;
  galaxyCollisionVariant: GalaxyCollisionVariant;
  bodyCountInput: string;
  stableFamily: StableOrbitFamily;
  accretionRadiusInput: string;
  accretionRadiusTouched: boolean;
};

export type LandingPageProps = {
  formState: ScenarioFormState;
  onFormStateChange: (nextState: ScenarioFormState) => void;
  onSimulate: (selection: ScenarioSelection) => void;
  onMasterLogin: (password: string, name: string) => boolean;
  onMasterLogout?: () => void;
  authErrorMessage?: string | null;
};

type ScenarioDetails = {
  title: string;
  subtitle: string;
  description: string;
  parameterHint: string;
};

const SCENARIO_ORDER: PrimaryScenarioKind[] = [
  'galaxy',
  'galaxy-collision',
  'stable-orbits',
  'accretion-disk'
];

const SCENARIO_DETAILS_BY_KIND: Record<PrimaryScenarioKind, ScenarioDetails> = {
  galaxy: {
    title: 'Galaxy',
    subtitle: 'Prebuilt Snapshot',
    description: 'Load a single galaxy snapshot and inspect long-term orbital behavior.',
    parameterHint: 'Select 10K for faster performance or 30K for maximum detail.'
  },
  'galaxy-collision': {
    title: 'Galaxy Collision',
    subtitle: 'Prebuilt Snapshot',
    description: 'Launch two galaxies on a collision course and follow tidal interactions.',
    parameterHint: 'Select 15K for lighter overhead or 30K for maximum detail.'
  },
  'stable-orbits': {
    title: 'Stable Orbits',
    subtitle: 'Generated at Runtime',
    description: 'Generate N-body choreography families and watch their dance.',
    parameterHint: 'Select a family and choose a compatible body count.'
  },
  'accretion-disk': {
    title: 'Accretion Disk',
    subtitle: 'Generated at Runtime',
    description: 'Spawn a central massive body with an orbiting disk of particles.',
    parameterHint: 'Body count auto-suggests a proportional radius; edit radius if you want a denser or wider disk.'
  }
};

const STABLE_ORBIT_FAMILY_LABELS: Record<StableOrbitFamily, string> = {
  auto: 'Auto',
  polygon: 'Polygon',
  multiring: 'Multiring',
  wheel: 'Wheel',
  hierarchical: 'Hierarchical',
  bhh: 'BHH',
  'suvakov-dmitrasinovic': 'Suvakov-Dmitrasinovic',
  retrograde: 'Retrograde',
  interplay: 'Interplay',
  figure8: 'Figure 8',
  'lagrange-3': 'Lagrange-3',
  'euler-3': 'Euler-3'
};

const DEFAULT_ACCRETION_DISK_BODY_COUNT = 10000;

function formatNumericInput(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isFinite(rounded) ? String(rounded) : '';
}

export const DEFAULT_SCENARIO_FORM_STATE: ScenarioFormState = {
  kind: 'galaxy',
  galaxyVariant: '10k',
  galaxyCollisionVariant: '15k',
  bodyCountInput: '3',
  stableFamily: 'auto',
  accretionRadiusInput: formatNumericInput(
    deriveAccretionDiskRadiusFromBodyCount(DEFAULT_ACCRETION_DISK_BODY_COUNT)
  ),
  accretionRadiusTouched: false
};

function defaultBodyCountFor(kind: PrimaryScenarioKind): string {
  if (kind === 'stable-orbits') {
    return '3';
  }
  if (kind === 'accretion-disk') {
    return String(DEFAULT_ACCRETION_DISK_BODY_COUNT);
  }
  return '3';
}

function parsePositiveInteger(raw: string): number | null {
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 2) {
    return null;
  }

  return parsed;
}

function parsePositiveNumber(raw: string): number | null {
  const normalized = raw.trim();
  if (normalized.length === 0) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function scenarioNeedsBodyCount(kind: PrimaryScenarioKind): kind is 'stable-orbits' | 'accretion-disk' {
  return kind === 'stable-orbits' || kind === 'accretion-disk';
}

function buildScenarioSelection(formState: ScenarioFormState): ScenarioSelection | null {
  switch (formState.kind) {
    case 'galaxy':
      return formState.galaxyVariant === '10k'
        ? { kind: 'galaxy-10k' }
        : { kind: 'galaxy' };
    case 'galaxy-collision':
      return formState.galaxyCollisionVariant === '15k'
        ? { kind: 'galaxy-collision-15k' }
        : { kind: 'galaxy-collision' };
    case 'stable-orbits': {
      const bodyCount = parsePositiveInteger(formState.bodyCountInput);
      if (bodyCount === null) {
        return null;
      }

      return {
        kind: 'stable-orbits',
        stableFamily: formState.stableFamily,
        bodyCount
      };
    }
    case 'accretion-disk': {
      const bodyCount = parsePositiveInteger(formState.bodyCountInput);
      const maxRadius = parsePositiveNumber(formState.accretionRadiusInput);
      if (bodyCount === null || maxRadius === null) {
        return null;
      }

      return {
        kind: 'accretion-disk',
        bodyCount,
        maxRadius
      };
    }
    default:
      return null;
  }
}
export type { ScenarioFormState };

type DropdownOption<T extends string> = {
  value: T;
  label: string;
};

type CustomSelectDropdownProps<T extends string> = {
  value: T;
  options: readonly DropdownOption<T>[];
  disabled?: boolean;
  onChange: (value: T) => void;
  ariaLabel: string;
};

function CustomSelectDropdown<T extends string>({
  value,
  options,
  disabled = false,
  onChange,
  ariaLabel
}: CustomSelectDropdownProps<T>) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const suppressTriggerClickRef = useRef(false);
  const suppressTriggerClickTimeoutRef = useRef<number | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [openDirection, setOpenDirection] = useState<'down' | 'up'>('down');

  const selectedIndex = Math.max(
    0,
    options.findIndex((opt) => opt.value === value)
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const lastIndex = options.length - 1;

  useEffect(() => {
    setActiveIndex(selectedIndex);
  }, [selectedIndex]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const activeOption = optionRefs.current[activeIndex];
    activeOption?.focus();
  }, [activeIndex, isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    const positionMenu = () => {
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      if (!triggerRect) {
        return;
      }

      const viewportPadding = 12;
      const dropdownGap = 6;
      const measuredMenuHeight = menuWrapRef.current?.offsetHeight ?? 0;
      const menuHeight = Math.max(100, Math.min(300, measuredMenuHeight || 240));
      const spaceBelow = window.innerHeight - triggerRect.bottom - viewportPadding;
      const spaceAbove = triggerRect.top - viewportPadding;
      const shouldOpenUp = spaceBelow < menuHeight + dropdownGap && spaceAbove > spaceBelow;

      setOpenDirection(shouldOpenUp ? 'up' : 'down');
    };

    const rafId = requestAnimationFrame(positionMenu);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!disabled) {
      return;
    }
    setIsOpen(false);
  }, [disabled]);

  useEffect(() => {
    return () => {
      if (suppressTriggerClickTimeoutRef.current !== null) {
        window.clearTimeout(suppressTriggerClickTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const positionMenu = () => {
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      if (!triggerRect) {
        return;
      }

      const viewportPadding = 12;
      const dropdownGap = 6;
      const measuredMenuHeight = menuWrapRef.current?.offsetHeight ?? 0;
      const menuHeight = Math.max(100, Math.min(300, measuredMenuHeight || 240));
      const spaceBelow = window.innerHeight - triggerRect.bottom - viewportPadding;
      const spaceAbove = triggerRect.top - viewportPadding;
      const shouldOpenUp = spaceBelow < menuHeight + dropdownGap && spaceAbove > spaceBelow;

      setOpenDirection(shouldOpenUp ? 'up' : 'down');
    };

    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);

    return () => {
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (!rootRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isOpen]);

  const clampIndex = (index: number): number => {
    if (index < 0) {
      return 0;
    }
    if (index > lastIndex) {
      return lastIndex;
    }
    return index;
  };

  const handleSelect = (optValue: T): void => {
    suppressTriggerClickRef.current = true;
    if (suppressTriggerClickTimeoutRef.current !== null) {
      window.clearTimeout(suppressTriggerClickTimeoutRef.current);
    }
    suppressTriggerClickTimeoutRef.current = window.setTimeout(() => {
      suppressTriggerClickRef.current = false;
      suppressTriggerClickTimeoutRef.current = null;
    }, 180);

    onChange(optValue);
    setIsOpen(false);
    requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  };

  const moveActive = (delta: number): void => {
    setActiveIndex((prev) => clampIndex(prev + delta));
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) {
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex(selectedIndex);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setIsOpen((current) => !current);
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(lastIndex);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) {
        handleSelect(option.value);
      }
      return;
    }

    if (event.key === 'Tab') {
      setIsOpen(false);
    }
  };

  const currentOption = options.find((opt) => opt.value === value) ?? options[0];

  return (
    <div
      className={styles.customSelect}
      data-open={isOpen}
      data-open-direction={openDirection}
      data-disabled={disabled}
      ref={rootRef}
    >
      <button
        type="button"
        className={styles.customSelectTrigger}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        onClick={() => {
          if (suppressTriggerClickRef.current) {
            suppressTriggerClickRef.current = false;
            return;
          }
          setIsOpen((current) => !current);
        }}
        onKeyDown={handleTriggerKeyDown}
        disabled={disabled}
        ref={triggerRef}
      >
        <span className={styles.customSelectValue}>{currentOption?.label ?? ''}</span>
        <svg
          className={styles.customSelectChevron}
          width="24"
          height="24"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {isOpen && (
        <div className={styles.customSelectMenuWrap} ref={menuWrapRef}>
          <div className={styles.customSelectMenuFrame}>
            <ul
              id={listboxId}
              className={styles.customSelectMenu}
              role="listbox"
              aria-label={ariaLabel}
              onKeyDown={handleMenuKeyDown}
            >
              {options.map((option, index) => {
                const isSelected = option.value === value;
                const isActive = index === activeIndex;

                return (
                  <li key={option.value} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={styles.customSelectOption}
                      data-selected={isSelected}
                      data-active={isActive}
                      onMouseEnter={() => {
                        setActiveIndex(index);
                      }}
                      onClick={() => {
                        handleSelect(option.value);
                      }}
                      ref={(element) => {
                        optionRefs.current[index] = element;
                      }}
                    >
                      {option.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

const STABLE_FAMILY_OPTIONS: readonly DropdownOption<StableOrbitFamily>[] =
  STABLE_ORBIT_FAMILIES.map((family) => ({
    value: family,
    label: STABLE_ORBIT_FAMILY_LABELS[family]
  }));

const GALAXY_VARIANT_OPTIONS: readonly DropdownOption<GalaxyVariant>[] = [
  { value: '10k', label: '10K Bodies (Lightweight)' },
  { value: '30k', label: '30K Bodies' }
];

const GALAXY_COLLISION_VARIANT_OPTIONS: readonly DropdownOption<GalaxyCollisionVariant>[] = [
  { value: '15k', label: '15K Bodies (Lightweight)' },
  { value: '30k', label: '30K Bodies' }
];

function StableFamilyDropdown({
  value,
  disabled = false,
  onChange
}: {
  value: StableOrbitFamily;
  disabled?: boolean;
  onChange: (family: StableOrbitFamily) => void;
}) {
  return (
    <CustomSelectDropdown
      value={value}
      options={STABLE_FAMILY_OPTIONS}
      disabled={disabled}
      onChange={onChange}
      ariaLabel="Stable Orbit Family"
    />
  );
}

function GalaxyVariantDropdown({
  value,
  disabled = false,
  onChange
}: {
  value: GalaxyVariant;
  disabled?: boolean;
  onChange: (variant: GalaxyVariant) => void;
}) {
  return (
    <CustomSelectDropdown
      value={value}
      options={GALAXY_VARIANT_OPTIONS}
      disabled={disabled}
      onChange={onChange}
      ariaLabel="Galaxy Body Count"
    />
  );
}

function GalaxyCollisionVariantDropdown({
  value,
  disabled = false,
  onChange
}: {
  value: GalaxyCollisionVariant;
  disabled?: boolean;
  onChange: (variant: GalaxyCollisionVariant) => void;
}) {
  return (
    <CustomSelectDropdown
      value={value}
      options={GALAXY_COLLISION_VARIANT_OPTIONS}
      disabled={disabled}
      onChange={onChange}
      ariaLabel="Galaxy Collision Body Count"
    />
  );
}

export function LandingPage({
  formState,
  onFormStateChange,
  onSimulate,
  onMasterLogin,
  onMasterLogout,
  authErrorMessage
}: LandingPageProps) {
  const {
    userRole,
    isComputeExhausted,
    isLocallyHosted,
    isLoginLocked,
    remainingLoginAttempts,
    lastAuthError
  } = useFrameStore((state) => ({
    userRole: state.userRole,
    isComputeExhausted: state.isComputeExhausted,
    isLocallyHosted: state.isLocallyHosted,
    isLoginLocked: state.isLoginLocked,
    remainingLoginAttempts: state.remainingLoginAttempts,
    lastAuthError: state.lastAuthError
  }));

  const isAuthorized = isLocallyHosted || userRole === 'master';
  const isLocked = isLoginLocked || remainingLoginAttempts === 0;
  const effectiveAuthError = authErrorMessage ?? lastAuthError;

  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [submittingAuth, setSubmittingAuth] = useState(false);

  const selectedScenario = formState.kind;
  const selectedScenarioDetails = SCENARIO_DETAILS_BY_KIND[selectedScenario];
  const scenarioSelection = buildScenarioSelection(formState);
  const [scenarioSwitching, setScenarioSwitching] = useState(false);
  const scenarioSwitchTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (scenarioSwitchTimeoutRef.current !== null) {
        window.clearTimeout(scenarioSwitchTimeoutRef.current);
      }
    };
  }, []);

  let validationError: string | null = null;
  if (scenarioNeedsBodyCount(selectedScenario) && parsePositiveInteger(formState.bodyCountInput) === null) {
    validationError = 'Body count must be a whole number greater than or equal to 2.';
  } else if (selectedScenario === 'accretion-disk' && parsePositiveNumber(formState.accretionRadiusInput) === null) {
    validationError = 'Disk radius must be a number greater than 0.';
  } else if (scenarioSelection !== null) {
    validationError = validateScenarioSelection(scenarioSelection);
  }

  const canSimulate = scenarioSelection !== null && validationError === null;

  function handleScenarioPick(nextScenario: PrimaryScenarioKind): void {
    if (nextScenario === selectedScenario) {
      return;
    }

    if (scenarioSwitchTimeoutRef.current !== null) {
      window.clearTimeout(scenarioSwitchTimeoutRef.current);
    }

    setScenarioSwitching(true);
    scenarioSwitchTimeoutRef.current = window.setTimeout(() => {
      setScenarioSwitching(false);
      scenarioSwitchTimeoutRef.current = null;
    }, 280);

    const nextBodyCountInput = defaultBodyCountFor(nextScenario);
    const nextBodyCount = parsePositiveInteger(nextBodyCountInput);

    onFormStateChange({
      ...formState,
      kind: nextScenario,
      bodyCountInput: nextBodyCountInput,
      accretionRadiusInput:
        nextScenario === 'accretion-disk' && nextBodyCount !== null
          ? formatNumericInput(deriveAccretionDiskRadiusFromBodyCount(nextBodyCount))
          : formState.accretionRadiusInput,
      accretionRadiusTouched: false
    });
  }

  function handleAuthSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!authPassword.trim() || isLocked) {
      return;
    }

    setSubmittingAuth(true);
    onMasterLogin(authPassword, authName.trim() || 'Master');
    setSubmittingAuth(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!scenarioSelection || validationError !== null || (!isLocallyHosted && isComputeExhausted)) {
      return;
    }

    onSimulate(scenarioSelection);
  }

  return (
    <section className={styles.landingShell}>
      <div className={styles.landingFrame}>
        <div className={styles.heroPanel}>
          <p className={styles.eyebrow}>Realtime Gravity Sandbox</p>
          <h1 className={styles.heroTitle}>N-Body Simulation Console</h1>
          <p className={styles.heroBlurb}>
            Pick a scenario, tune startup parameters, and launch straight into the live HUD and
            3D renderer.
          </p>
          <article className={styles.nBodyExplainer}>
            <h2>What is this simulator?</h2>
            <p>
              Think of this as a gravity playground. Every body pulls on every other body, and the
              app keeps recalculating their motion over tiny time steps. That lets you watch simple
              starts turn into swirls, collisions, and orbit patterns in real time.
            </p>
          </article>
          <div className={styles.heroMetaRow}>
            <div className={styles.metaItem}>
              <span>Engine</span>
              <strong>Barnes-Hut + Verlet</strong>
            </div>
            <div className={styles.metaItem}>
              <span>Transport</span>
              <strong>WebSocket Stream</strong>
            </div>
            <div className={styles.metaItem}>
              <span>Computed</span>
              <strong>In Real Time</strong>
            </div>
          </div>
        </div>

        {!isAuthorized ? (
          <form className={styles.controlPanel} onSubmit={handleAuthSubmit} noValidate>
            <div className={styles.selectorHeading}>Master Access</div>
            <article className={styles.authCard}>
              <div className={styles.authTitleWrapper}>
                <span className={styles.authCrownIcon} aria-hidden="true">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
                    <path d="M5 21h14" />
                  </svg>
                </span>
                <div>
                  <h2 className={styles.authTitle}>Master Authentication</h2>
                  <p className={styles.authSubtitle}>Console Operator Access</p>
                </div>
              </div>

              <p className={styles.authDescription}>
                The Master has exclusive control to select scenarios, launch simulations, pause/play,
                and adjust physics speed. Up to 6 spectators can observe simultaneously.
              </p>

              {isLocked ? (
                <div className={styles.authLockoutBanner} role="alert">
                  Master authentication is locked out for the day (maximum 5 failed attempts exceeded). Please return tomorrow.
                </div>
              ) : (
                <>
                  {effectiveAuthError && (
                    <div className={styles.authErrorBanner} role="alert">
                      {effectiveAuthError}
                    </div>
                  )}
                  {remainingLoginAttempts < 5 && (
                    <div className={styles.authWarningBanner} role="status">
                      {remainingLoginAttempts} attempt(s) remaining before daily lockout.
                    </div>
                  )}
                </>
              )}

              {isComputeExhausted && (
                <div className={styles.computeExhaustedNotice} role="alert">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span>
                    <strong>Daily Compute Limit Reached (1.5h).</strong> Today&apos;s simulation quota has been exhausted. Please return tomorrow to continue using the simulator.
                  </span>
                </div>
              )}

              <div className={styles.authFieldsGroup}>
                <label className={styles.formField}>
                  <span>Display Name</span>
                  <input
                    type="text"
                    placeholder="e.g. Commander (or leave empty)"
                    value={authName}
                    onChange={(e) => setAuthName(e.target.value)}
                    maxLength={24}
                    autoComplete="name"
                  />
                </label>

                <label className={styles.formField}>
                  <span>Master Password *</span>
                  <input
                    type="password"
                    placeholder={isLocked ? 'Authentication locked for today' : 'Enter password'}
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    required
                    disabled={isLocked}
                    autoFocus={!isLocked}
                    autoComplete="current-password"
                  />
                </label>
              </div>

              <div className={styles.actionRow}>
                <button
                  className={styles.simulateButton}
                  type="submit"
                  disabled={submittingAuth || !authPassword.trim() || isLocked}
                >
                  {isLocked ? 'Authentication Locked' : 'Authenticate as Master'}
                </button>
              </div>
            </article>
          </form>
        ) : (
          <form className={styles.controlPanel} onSubmit={handleSubmit} noValidate>
            <div className={styles.selectorHeading}>Scenario Selector</div>
            <div className={styles.selectorGrid} role="radiogroup" aria-label="Scenario selector">
              {SCENARIO_ORDER.map((scenarioKind) => {
                const scenarioDetails = SCENARIO_DETAILS_BY_KIND[scenarioKind];
                const selected = selectedScenario === scenarioKind;

                return (
                  <a
                    key={scenarioKind}
                    href="#simulate"
                    className={styles.selectorButton}
                    data-selected={selected}
                    onClick={() => handleScenarioPick(scenarioKind)}
                    aria-pressed={selected}
                  >
                    <span>{scenarioDetails.title}</span>
                    <small>{scenarioDetails.subtitle}</small>
                  </a>
                );
              })}
            </div>

            <article className={styles.parameterCard} data-switching={scenarioSwitching}>
              <div className={styles.parameterDetailsRegion}>
                <div key={`scenario-details-${selectedScenario}`} className={styles.parameterDetailsContent}>
                  <header className={styles.parameterHeader}>
                    <div>
                      <h2>{selectedScenarioDetails.title}</h2>
                      <p>{selectedScenarioDetails.subtitle}</p>
                    </div>
                  </header>
                  <p className={styles.parameterDescription}>{selectedScenarioDetails.description}</p>
                </div>
              </div>

              <div
                className={styles.formFieldCollapse}
                data-open={selectedScenario === 'galaxy'}
                aria-hidden={selectedScenario !== 'galaxy'}
              >
                <div className={styles.formFieldCollapseInner}>
                  <label className={styles.formField}>
                    <span>Body Count</span>
                    <GalaxyVariantDropdown
                      value={formState.galaxyVariant}
                      disabled={selectedScenario !== 'galaxy'}
                      onChange={(variant) => {
                        onFormStateChange({
                          ...formState,
                          galaxyVariant: variant
                        });
                      }}
                    />
                  </label>
                </div>
              </div>

              <div
                className={styles.formFieldCollapse}
                data-open={selectedScenario === 'galaxy-collision'}
                aria-hidden={selectedScenario !== 'galaxy-collision'}
              >
                <div className={styles.formFieldCollapseInner}>
                  <label className={styles.formField}>
                    <span>Body Count</span>
                    <GalaxyCollisionVariantDropdown
                      value={formState.galaxyCollisionVariant}
                      disabled={selectedScenario !== 'galaxy-collision'}
                      onChange={(variant) => {
                        onFormStateChange({
                          ...formState,
                          galaxyCollisionVariant: variant
                        });
                      }}
                    />
                  </label>
                </div>
              </div>

              <div
                className={styles.formFieldCollapse}
                data-open={selectedScenario === 'stable-orbits'}
                aria-hidden={selectedScenario !== 'stable-orbits'}
              >
                <div className={styles.formFieldCollapseInner}>
                  <label className={styles.formField}>
                    <span>Stable Orbit Family</span>
                    <StableFamilyDropdown
                      value={formState.stableFamily}
                      disabled={selectedScenario !== 'stable-orbits'}
                      onChange={(family) => {
                        onFormStateChange({
                          ...formState,
                          stableFamily: family
                        });
                      }}
                    />
                  </label>
                </div>
              </div>

              <div
                className={styles.formFieldCollapse}
                data-open={scenarioNeedsBodyCount(selectedScenario)}
                aria-hidden={!scenarioNeedsBodyCount(selectedScenario)}
              >
                <div className={styles.formFieldCollapseInner}>
                  <label className={styles.formField}>
                    <span>Body Count</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={2}
                      step={1}
                      value={formState.bodyCountInput}
                      disabled={!scenarioNeedsBodyCount(selectedScenario)}
                      onChange={(event) => {
                        const nextBodyCountInput = event.target.value;
                        let nextAccretionRadiusInput = formState.accretionRadiusInput;

                        if (selectedScenario === 'accretion-disk' && !formState.accretionRadiusTouched) {
                          const nextBodyCount = parsePositiveInteger(nextBodyCountInput);
                          if (nextBodyCount !== null) {
                            nextAccretionRadiusInput = formatNumericInput(
                              deriveAccretionDiskRadiusFromBodyCount(nextBodyCount)
                            );
                          }
                        }

                        onFormStateChange({
                          ...formState,
                          bodyCountInput: nextBodyCountInput,
                          accretionRadiusInput: nextAccretionRadiusInput
                        });
                      }}
                      placeholder="Enter body count"
                    />
                  </label>
                </div>
              </div>

              <div
                className={styles.formFieldCollapse}
                data-open={selectedScenario === 'accretion-disk'}
                aria-hidden={selectedScenario !== 'accretion-disk'}
              >
                <div className={styles.formFieldCollapseInner}>
                  <label className={styles.formField}>
                    <span>Disk Radius</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      value={formState.accretionRadiusInput}
                      disabled={selectedScenario !== 'accretion-disk'}
                      onChange={(event) => {
                        onFormStateChange({
                          ...formState,
                          accretionRadiusInput: event.target.value,
                          accretionRadiusTouched: true
                        });
                      }}
                      placeholder="Disc Radius"
                    />
                  </label>
                </div>
              </div>

              <div className={styles.parameterHintRegion}>
                <p key={`scenario-hint-${selectedScenario}`} className={`${styles.parameterHint} ${styles.scenarioHint}`.trim()}>
                  {selectedScenarioDetails.parameterHint}
                </p>
              </div>

              <div
                className={styles.inlineErrorWrap}
                data-open={validationError !== null}
                aria-hidden={validationError === null}
                aria-live="polite"
              >
                <div className={styles.inlineErrorInner}>
                  <p className={styles.inlineError}>{validationError ?? ''}</p>
                </div>
              </div>

              {!isLocallyHosted && isComputeExhausted && (
                <div className={styles.computeExhaustedNotice} role="alert">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span>
                    <strong>Daily Compute Limit Reached (1.5h).</strong> Today&apos;s simulation quota has been exhausted. Please return tomorrow to continue using the simulator.
                  </span>
                </div>
              )}

              <div className={styles.actionRow}>
                <button
                  id="simulate"
                  className={styles.simulateButton}
                  type="submit"
                  disabled={!canSimulate || (!isLocallyHosted && isComputeExhausted)}
                  title={!isLocallyHosted && isComputeExhausted ? 'Daily compute limit reached. Please return tomorrow.' : undefined}
                >
                  Simulate
                </button>
                {!isLocallyHosted && onMasterLogout && (
                  <button
                    className={styles.logoutSquareButton}
                    type="button"
                    onClick={onMasterLogout}
                    title="Log Out as Master"
                    aria-label="Log Out as Master"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m16 17 5-5-5-5" />
                      <path d="M21 12H9" />
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    </svg>
                  </button>
                )}
              </div>
            </article>
          </form>
        )}
      </div>
    </section>
  );
}
