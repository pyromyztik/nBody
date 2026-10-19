import { useEffect, useState } from 'react';
import { shallow } from 'zustand/shallow';
import { useFrameStore } from '../../state/useFrameStore';
import type { ConnectionStatus } from '../../state/useFrameStore';
import styles from './HudPanel.module.css';
import { HudSettings } from './HudSettings';

type HudPanelProps = {
  scenarioTitle: string;
  status: ConnectionStatus;
  wsUrl: string;
  controlsDisabled: boolean;
  onSendControlMessage: (message: string) => boolean;
  onBackToLanding: () => void;
  onOpenMasterLogin?: () => void;
};

function HudStats() {
  const [frontendFps, setFrontendFps] = useState(0);
  const { frame, bodyCount, fps: backendFps, totalBytes } = useFrameStore(
    (state) => ({
      frame: state.frame,
      bodyCount: state.bodyCount,
      fps: state.fps,
      totalBytes: state.totalBytes
    }),
    shallow
  );

  useEffect(() => {
    const sampleWindowMs = 250;
    let rafId = 0;
    let frameCount = 0;
    let sampleStart = performance.now();
    let previousTick = sampleStart;

    const measure = (now: number) => {
      if (now - previousTick > 1000) {
        frameCount = 0;
        sampleStart = now;
      }
      previousTick = now;
      frameCount += 1;

      const elapsed = now - sampleStart;
      if (elapsed >= sampleWindowMs) {
        const nextFps = (frameCount * 1000) / elapsed;
        setFrontendFps((current) => (current > 0 ? current * 0.6 + nextFps * 0.4 : nextFps));
        frameCount = 0;
        sampleStart = now;
      }
      rafId = window.requestAnimationFrame(measure);
    };

    rafId = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(rafId);
  }, []);

  return (
    <div className={styles.hudStats}>
      <div className={styles.statCol}>
        <div>
          <strong>FPS</strong> {frontendFps.toFixed(1)}{' '}
          <span className={styles.statSecondary}>{`(${backendFps.toFixed(1)})`}</span>
        </div>
        <div>
          <strong>Frame</strong> {frame}
        </div>
      </div>
      <div className={styles.statCol}>
        <div>
          <strong>Received</strong> {(totalBytes / 1_000_000).toFixed(2)} MB
        </div>
        <div>
          <strong>Bodies</strong> {bodyCount}
        </div>
      </div>
      <div className={styles.statCol} />
    </div>
  );
}

export function HudPanel({
  scenarioTitle,
  status,
  wsUrl,
  controlsDisabled,
  onSendControlMessage,
  onBackToLanding,
  onOpenMasterLogin
}: HudPanelProps) {
  const [hudMinimized, setHudMinimized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { userRole } = useFrameStore((state) => ({
    userRole: state.userRole
  }));

  function handleToggleHudMinimized(): void {
    setHudMinimized((current) => {
      const next = !current;
      if (next) {
        setSettingsOpen(false);
      }
      return next;
    });
  }

  useEffect(() => {
    const handleHudHotkeys = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || ev.repeat) {
        return;
      }

      const target = ev.target as HTMLElement | null;
      if (target) {
        const tagName = target.tagName;
        if (
          tagName === 'INPUT'
          || tagName === 'TEXTAREA'
          || tagName === 'SELECT'
          || target.isContentEditable
        ) {
          return;
        }
      }

      if (ev.code === 'KeyE' || ev.key === 'e' || ev.key === 'E') {
        ev.preventDefault();
        setHudMinimized((current) => {
          const next = !current;
          if (next) {
            setSettingsOpen(false);
          }
          return next;
        });
        return;
      }
      if (ev.key !== 'Escape') {
        return;
      }
      if (settingsOpen) {
        ev.preventDefault();
        setSettingsOpen(false);
        return;
      }
      if (!hudMinimized) {
        ev.preventDefault();
        setHudMinimized(true);
      }
    };

    window.addEventListener('keydown', handleHudHotkeys);
    return () => {
      window.removeEventListener('keydown', handleHudHotkeys);
    };
  }, [hudMinimized, settingsOpen]);

  return (
    <div className={styles.hudColumn}>
      <div className={`${styles.hud} ${hudMinimized ? styles.hudMinimized : ''}`.trim()}>
        <div className={styles.hudHeader}>
          <h1 className={styles.hudTitle}>{scenarioTitle}</h1>
          <div className={styles.hudActions}>
            {userRole === 'master' && (
              <button
                className={`${styles.hudIconButton} ${styles.hudBackButton}`.trim()}
                type="button"
                onClick={onBackToLanding}
                aria-label="Back to landing page"
                title="Back to scenario selector"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m12 19-7-7 7-7"/>
                  <path d="M19 12H5"/>
                </svg>
              </button>
            )}
            <button
              className={styles.hudIconButton}
              type="button"
              onClick={handleToggleHudMinimized}
              aria-label={hudMinimized ? 'Expand HUD panel' : 'Minimize HUD panel'}
              title={hudMinimized ? 'Expand HUD panel' : 'Minimize HUD panel'}
            >
              {hudMinimized ? (
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
                  <path d="M4 5h16" />
                  <path d="M4 12h16" />
                  <path d="M4 19h16" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
                  <path d="m14 10 7-7" />
                  <path d="M20 10h-6V4" />
                  <path d="m3 21 7-7" />
                  <path d="M4 14h6v6" />
                </svg>
              )}
            </button>
          </div>
        </div>
        <div className={`${styles.hudBody} 
                         ${hudMinimized ? styles.isCollapsed : ''}`.trim()} 
                         aria-hidden={hudMinimized}>
          <div className={styles.hudBodyInner}>
            <div className={styles.hudConnectionLine}>
              <span className={`${styles.dot} 
                                ${status === 'connected' ? styles.ok : ''}`.trim()} />
              {status} <div className={styles.wsurl}>· <small>{wsUrl}</small></div>
            </div>
            <small>Stats</small>
            <HudStats />
            <HudSettings
              settingsOpen={settingsOpen}
              onToggleSettings={() => setSettingsOpen((open) => !open)}
              controlsDisabled={controlsDisabled}
              onSendControlMessage={onSendControlMessage}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
