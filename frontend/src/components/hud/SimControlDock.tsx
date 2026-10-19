import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useFrameStore } from '../../state/useFrameStore';
import styles from './SimControlDock.module.css';

const BASE_SIM_DT = 0.016667;
const MIN_SIM_SPEED_MULTIPLIER = 0.1;
const MAX_SIM_SPEED_MULTIPLIER = 10;
const MIN_KEYBOARD_SIM_SPEED_MULTIPLIER = 0.01;

type SimControlDockProps = {
  controlsDisabled: boolean;
  simPaused: boolean;
  simDt: number;
  onSendControlMessage: (message: string) => boolean;
};

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }

  const tagName = element.tagName;
  return (
    tagName === 'INPUT'
    || tagName === 'TEXTAREA'
    || tagName === 'SELECT'
    || element.isContentEditable
  );
}

function sliderToSimSpeedMultiplier(value: number): number {
  return Math.pow(10, 2 * value - 1);
}

export function SimControlDock({
  controlsDisabled,
  simPaused,
  simDt,
  onSendControlMessage
}: SimControlDockProps) {
  const {
    userRole,
    hasMaster,
    masterName,
    spectatorCount,
    maxComputeSeconds,
    computeRemainingSeconds,
    isComputeExhausted,
    isLocallyHosted
  } = useFrameStore((state) => ({
    userRole: state.userRole,
    hasMaster: state.hasMaster,
    masterName: state.masterName,
    spectatorCount: state.spectatorCount,
    maxComputeSeconds: state.maxComputeSeconds,
    computeRemainingSeconds: state.computeRemainingSeconds,
    isComputeExhausted: state.isComputeExhausted,
    isLocallyHosted: state.isLocallyHosted
  }));
  const isMaster = userRole === 'master' || isLocallyHosted;
  const effectiveDisabled = controlsDisabled || (!isLocallyHosted && (!isMaster || isComputeExhausted));
  const lockTitle = !isLocallyHosted
    ? (isComputeExhausted
        ? 'Daily compute limit reached (1.5h). Please return tomorrow.'
        : (!isMaster ? `Controlled by Master (${masterName || 'Master'})` : undefined))
    : undefined;
  const totalUsers = (hasMaster ? 1 : 0) + spectatorCount;

  const remainingSeconds = Math.max(0, computeRemainingSeconds ?? 5400);
  const totalMaxSeconds = maxComputeSeconds > 0 ? maxComputeSeconds : 5400;
  const remainingFraction = Math.min(1, Math.max(0, remainingSeconds / totalMaxSeconds));

  const hoursRemaining = Math.floor(remainingSeconds / 3600);
  const minsRemaining = Math.floor((remainingSeconds % 3600) / 60);
  const formattedFullRemaining = hoursRemaining > 0
    ? `${hoursRemaining}h ${minsRemaining}m`
    : `${minsRemaining}m`;

  const formattedCompactRemaining = isComputeExhausted || remainingSeconds <= 0
    ? '0m'
    : remainingSeconds >= 3600
      ? `${(remainingSeconds / 3600).toFixed(1)}h`
      : `${Math.ceil(remainingSeconds / 60)}m`;

  const strokeColor = isComputeExhausted || remainingFraction < 0.15
    ? '#f87171'
    : remainingFraction < 0.4
      ? '#fbbf24'
      : '#38bdf8';

  const CIRCLE_RADIUS = 6.5;
  const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS; // ~40.84
  const strokeDashoffset = CIRCLE_CIRCUMFERENCE * (1 - remainingFraction);

  const speedPopoverCloseTimeoutRef = useRef<number | null>(null);
  const [speedPopoverOpen, setSpeedPopoverOpen] = useState(false);

  const simSpeedMultiplier = Math.max(MIN_KEYBOARD_SIM_SPEED_MULTIPLIER, simDt / BASE_SIM_DT);
  const sliderBoundedMultiplier = Math.max(
    MIN_SIM_SPEED_MULTIPLIER,
    Math.min(MAX_SIM_SPEED_MULTIPLIER, simDt / BASE_SIM_DT)
  );
  const simSpeedSliderValue = Math.max(0, Math.min(1, (Math.log10(sliderBoundedMultiplier) + 1) / 2));
  const simSpeedPercent = `${(simSpeedSliderValue * 100).toFixed(2)}%`;

  function clearSpeedPopoverCloseTimeout(): void {
    if (speedPopoverCloseTimeoutRef.current !== null) {
      window.clearTimeout(speedPopoverCloseTimeoutRef.current);
      speedPopoverCloseTimeoutRef.current = null;
    }
  }

  function queueSpeedPopoverClose(): void {
    clearSpeedPopoverCloseTimeout();
    speedPopoverCloseTimeoutRef.current = window.setTimeout(() => {
      setSpeedPopoverOpen(false);
      speedPopoverCloseTimeoutRef.current = null;
    }, 350);
  }

  function handleSimSpeedChange(nextSliderValue: number): void {
    if (effectiveDisabled) {
      return;
    }

    const clampedSliderValue = Math.max(0, Math.min(1, nextSliderValue));
    const nextMultiplier = sliderToSimSpeedMultiplier(clampedSliderValue);
    const nextDt = BASE_SIM_DT * nextMultiplier;
    onSendControlMessage(`control:set?dt=${encodeURIComponent(nextDt.toFixed(6))}`);
  }

  useEffect(() => {
    if (effectiveDisabled) {
      clearSpeedPopoverCloseTimeout();
      setSpeedPopoverOpen(false);
    }
  }, [effectiveDisabled]);

  useEffect(() => {
    return () => {
      clearSpeedPopoverCloseTimeout();
    };
  }, []);

  useEffect(() => {
    const handleSpaceToggle = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || ev.repeat || effectiveDisabled) {
        return;
      }

      if (ev.code !== 'Space' && ev.key !== ' ') {
        return;
      }

      if (isEditableTarget(ev.target)) {
        return;
      }

      ev.preventDefault();
      onSendControlMessage(`control:set?paused=${simPaused ? 0 : 1}`);
    };

    window.addEventListener('keydown', handleSpaceToggle);
    return () => {
      window.removeEventListener('keydown', handleSpaceToggle);
    };
  }, [effectiveDisabled, onSendControlMessage, simPaused]);

  useEffect(() => {
    const handleTimeSpeedStep = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || ev.repeat || effectiveDisabled) {
        return;
      }

      if (isEditableTarget(ev.target)) {
        return;
      }

      const decreaseSpeed = ev.code === 'BracketLeft' || ev.key === '[';
      const increaseSpeed = ev.code === 'BracketRight' || ev.key === ']';
      if (!decreaseSpeed && !increaseSpeed) {
        return;
      }

      ev.preventDefault();
      const delta = increaseSpeed ? 1 : -1;
      const nextMultiplier = Math.max(MIN_KEYBOARD_SIM_SPEED_MULTIPLIER, simSpeedMultiplier + delta);
      const nextDt = BASE_SIM_DT * nextMultiplier;
      onSendControlMessage(`control:set?dt=${encodeURIComponent(nextDt.toFixed(6))}`);
    };

    window.addEventListener('keydown', handleTimeSpeedStep);
    return () => {
      window.removeEventListener('keydown', handleTimeSpeedStep);
    };
  }, [effectiveDisabled, onSendControlMessage, simSpeedMultiplier]);

  return (
    <div className={styles.simControlDock}>
      <div className={styles.simControlFloatingGroup} role="group" aria-label="Simulation controls">
        {!isLocallyHosted && (
          <>
            <div
              className={styles.simControlUserBadge}
              title={hasMaster ? `Master: ${masterName || 'Master'}` : 'No active master'}
              aria-label={`Users joined: ${totalUsers}. Master: ${hasMaster ? (masterName || 'Master') : 'None'}`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <path d="M16 3.128a4 4 0 0 1 0 7.744" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <circle cx="9" cy="7" r="4" />
              </svg>
              <span className={styles.simControlUserCount}>{totalUsers}</span>
              <div className={styles.simControlUserTooltip} role="tooltip">
                {hasMaster ? `Master: ${masterName || 'Master'}` : 'No active master'}
              </div>
            </div>
            <div
              className={`${styles.simControlComputeBadge} ${isComputeExhausted ? styles.isComputeExhausted : ''}`.trim()}
              title={isComputeExhausted ? 'Daily compute limit reached. Please return tomorrow.' : `Daily compute remaining: ${formattedFullRemaining} (1.5h limit)`}
              aria-label={`Daily compute remaining: ${formattedFullRemaining}`}
            >
              <svg className={styles.computeCircleSvg} viewBox="0 0 20 20" aria-hidden="true">
                <circle
                  className={styles.computeCircleBg}
                  cx="10"
                  cy="10"
                  r={CIRCLE_RADIUS}
                  strokeWidth="2.5"
                  fill="none"
                />
                <circle
                  className={styles.computeCircleFg}
                  cx="10"
                  cy="10"
                  r={CIRCLE_RADIUS}
                  strokeWidth="2.5"
                  fill="none"
                  stroke={strokeColor}
                  strokeDasharray={CIRCLE_CIRCUMFERENCE}
                  strokeDashoffset={strokeDashoffset}
                  strokeLinecap="round"
                />
              </svg>
              <span className={styles.simControlComputeText}>{formattedCompactRemaining}</span>
              <div className={styles.simControlUserTooltip} role="tooltip">
                {isComputeExhausted
                  ? 'Daily compute limit reached (1.5h). Please return tomorrow.'
                  : `Daily Compute: ${formattedFullRemaining} remaining of 1.5h today`}
              </div>
            </div>
          </>
        )}
        <button
          className={`${styles.simControlFab} ${simPaused ? styles.isPaused : ''}`.trim()}
          type="button"
          aria-label={simPaused ? 'Resume simulation' : 'Pause simulation'}
          title={lockTitle || (simPaused ? 'Resume simulation' : 'Pause simulation')}
          disabled={effectiveDisabled}
          onClick={() => {
            if (effectiveDisabled) {
              return;
            }
            onSendControlMessage(`control:set?paused=${simPaused ? 0 : 1}`);
          }}
        >
          {simPaused ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="14" y="3" width="5" height="18" rx="1" />
              <rect x="5" y="3" width="5" height="18" rx="1" />
            </svg>
          )}
        </button>
        <button
          className={styles.simControlFab}
          type="button"
          aria-label="Reset simulation"
          title={lockTitle || 'Reset simulation'}
          disabled={effectiveDisabled}
          onClick={() => {
            if (effectiveDisabled) {
              return;
            }
            onSendControlMessage('control:reset');
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
        <div className={styles.simControlSpeedWrap}>
          <button
            className={styles.simControlFab}
            type="button"
            aria-label="Adjust simulation speed"
            aria-haspopup="dialog"
            aria-expanded={speedPopoverOpen}
            title={lockTitle || `Time speed: ${simSpeedMultiplier.toFixed(2)}x`}
            disabled={effectiveDisabled}
            onClick={() => {
              if (effectiveDisabled) {
                return;
              }
              clearSpeedPopoverCloseTimeout();
              setSpeedPopoverOpen((open) => !open);
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m12 14 4-4" />
              <path d="M3.34 19a10 10 0 1 1 17.32 0" />
            </svg>
          </button>
          <div
            className={styles.simControlSpeedPopover}
            role="dialog"
            aria-label="Simulation speed"
            data-open={speedPopoverOpen}
            aria-hidden={!speedPopoverOpen}
            onMouseEnter={clearSpeedPopoverCloseTimeout}
            onMouseLeave={queueSpeedPopoverClose}
          >
            <label className={`${styles.hudSlider} ${styles.simControlSpeedSlider}`.trim()}>
              <span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m12 14 4-4" />
                  <path d="M3.34 19a10 10 0 1 1 17.32 0" />
                </svg>
                <span>Time speed: {simSpeedMultiplier.toFixed(2)}x</span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.001}
                value={simSpeedSliderValue}
                style={
                  {
                    '--percent': simSpeedPercent
                  } as CSSProperties
                }
                onChange={(ev) => handleSimSpeedChange(Number(ev.target.value))}
              />
              <div className={styles.simControlSpeedScale} aria-hidden="true">
                <span>0.1x</span>
                <span>1x</span>
                <span>10x</span>
              </div>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
