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

type ScenarioFormState = {
  kind: ScenarioKind;
  bodyCountInput: string;
  stableFamily: StableOrbitFamily;
  accretionRadiusInput: string;
  accretionRadiusTouched: boolean;
};

export type LandingPageProps = {
  formState: ScenarioFormState;
  onFormStateChange: (nextState: ScenarioFormState) => void;
  onSimulate: (selection: ScenarioSelection) => void;
  onOpenMasterLogin?: () => void;
  onMasterLogout?: () => void;
};

type ScenarioDetails = {
  title: string;
  subtitle: string;
  description: string;
  parameterHint: string;
};

const SCENARIO_ORDER: ScenarioKind[] = [
  'galaxy',
  'galaxy-collision',
  'stable-orbits',
  'accretion-disk'
];

const SCENARIO_DETAILS_BY_KIND: Record<ScenarioKind, ScenarioDetails> = {
  galaxy: {
    title: 'Galaxy',
    subtitle: 'Prebuilt Snapshot',
    description: 'Load a single galaxy snapshot and inspect long-term orbital behavior.',
    parameterHint: 'No additional parameters required.'
  },
  'galaxy-collision': {
    title: 'Galaxy Collision',
    subtitle: 'Prebuilt Snapshot',
    description: 'Launch two galaxies on a collision course and follow tidal interactions.',
    parameterHint: 'No additional parameters required.'
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

const DEFAULT_ACCRETION_DISK_BODY_COUNT = 15000;

function formatNumericInput(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isFinite(rounded) ? String(rounded) : '';
}

export const DEFAULT_SCENARIO_FORM_STATE: ScenarioFormState = {
  kind: 'galaxy',
  bodyCountInput: '3',
  stableFamily: 'auto',
  accretionRadiusInput: formatNumericInput(
    deriveAccretionDiskRadiusFromBodyCount(DEFAULT_ACCRETION_DISK_BODY_COUNT)
  ),
  accretionRadiusTouched: false
};

function defaultBodyCountFor(kind: ScenarioKind): string {
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

function scenarioNeedsBodyCount(kind: ScenarioKind): kind is 'stable-orbits' | 'accretion-disk' {
  return kind === 'stable-orbits' || kind === 'accretion-disk';
}

function buildScenarioSelection(formState: ScenarioFormState): ScenarioSelection | null {
  switch (formState.kind) {
    case 'galaxy':
      return { kind: 'galaxy' };
    case 'galaxy-collision':
      return { kind: 'galaxy-collision' };
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

type StableFamilyDropdownProps = {
  value: StableOrbitFamily;
  disabled?: boolean;
  onChange: (family: StableOrbitFamily) => void;
};

function StableFamilyDropdown({ value, disabled = false, onChange }: StableFamilyDropdownProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const suppressTriggerClickRef = useRef(false);
  const suppressTriggerClickTimeoutRef = useRef<number | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [openDirection, setOpenDirection] = useState<'down' | 'up'>('down');

  const selectedIndex = Math.max(0, STABLE_ORBIT_FAMILIES.indexOf(value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  const lastIndex = STABLE_ORBIT_FAMILIES.length - 1;

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
      const menuHeight = Math.max(190, Math.min(300, measuredMenuHeight || 240));
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
      const menuHeight = Math.max(190, Math.min(300, measuredMenuHeight || 240));
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

  const handleSelect = (family: StableOrbitFamily): void => {
    suppressTriggerClickRef.current = true;
    if (suppressTriggerClickTimeoutRef.current !== null) {
      window.clearTimeout(suppressTriggerClickTimeoutRef.current);
    }
    suppressTriggerClickTimeoutRef.current = window.setTimeout(() => {
      suppressTriggerClickRef.current = false;
      suppressTriggerClickTimeoutRef.current = null;
    }, 180);

    onChange(family);
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

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex(selectedIndex);
      return;
    }

    if (event.key === 'ArrowUp') {
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
      const family = STABLE_ORBIT_FAMILIES[activeIndex];
      if (family) {
        handleSelect(family);
      }
      return;
    }

    if (event.key === 'Tab') {
      setIsOpen(false);
    }
  };

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
        <span className={styles.customSelectValue}>{STABLE_ORBIT_FAMILY_LABELS[value]}</span>
        <svg
          className={styles.customSelectChevron}
          width="24" height="24"
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
              aria-label="Stable Orbit Family"
              onKeyDown={handleMenuKeyDown}
            >
              {STABLE_ORBIT_FAMILIES.map((family, index) => {
                const isSelected = family === value;
                const isActive = index === activeIndex;

                return (
                  <li key={family} role="presentation">
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
                        handleSelect(family);
                      }}
                      ref={(element) => {
                        optionRefs.current[index] = element;
                      }}
                    >
                      {STABLE_ORBIT_FAMILY_LABELS[family]}
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

export function LandingPage({
  formState,
  onFormStateChange,
  onSimulate,
  onOpenMasterLogin,
  onMasterLogout
}: LandingPageProps) {
  const userRole = useFrameStore((state) => state.userRole);

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

  function handleScenarioPick(nextScenario: ScenarioKind): void {
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

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (userRole !== 'master') {
      if (onOpenMasterLogin) {
        onOpenMasterLogin();
      }
      return;
    }

    if (!scenarioSelection || validationError !== null) {
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

            <div className={styles.actionRow}>
              {userRole === 'master' ? (
                <>
                  <button
                    id="simulate"
                    className={styles.simulateButton}
                    type="submit"
                    disabled={!canSimulate}
                  >
                    Simulate
                  </button>
                  {onMasterLogout && (
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
                </>
              ) : (
                <button
                  id="simulate"
                  className={styles.simulateButton}
                  type="button"
                  onClick={onOpenMasterLogin}
                >
                  Authenticate as Master to Simulate
                </button>
              )}
            </div>
          </article>
        </form>
      </div>
    </section>
  );
}
