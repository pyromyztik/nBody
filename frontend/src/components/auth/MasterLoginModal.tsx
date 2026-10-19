import { useState, type FormEvent } from 'react';
import styles from './MasterLoginModal.module.css';

type MasterLoginModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onLogin: (password: string, name: string) => boolean;
  errorMessage?: string | null;
};

export function MasterLoginModal({
  isOpen,
  onClose,
  onLogin,
  errorMessage
}: MasterLoginModalProps) {
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) {
    return null;
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;

    setSubmitting(true);
    const sent = onLogin(password, name.trim() || 'Master');
    setSubmitting(false);
    if (sent) {
      // Keep open until server acknowledges or errors, or close immediately
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose} role="dialog" aria-modal="true">
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.titleWrapper}>
            <span className={styles.crownIcon} aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/>
                <path d="M5 21h14"/>
              </svg>
            </span>
            <h2 className={styles.title}>Master Authentication</h2>
          </div>
          <button
            className={styles.closeButton}
            type="button"
            onClick={onClose}
            aria-label="Close modal"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <p className={styles.description}>
          The Master has exclusive control to select scenarios, launch simulations, pause/play, and adjust physics speed. Up to 6 spectators can observe simultaneously.
        </p>

        {errorMessage && (
          <div className={styles.errorBanner} role="alert">
            {errorMessage}
          </div>
        )}

        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="master-name-input">
              Your Display Name
            </label>
            <input
              id="master-name-input"
              className={styles.input}
              type="text"
              placeholder="e.g. Commander (or leave empty)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={24}
              autoComplete="name"
            />
          </div>

          <div className={styles.formGroup}>
            <label className={styles.label} htmlFor="master-password-input">
              Master Password *
            </label>
            <input
              id="master-password-input"
              className={styles.input}
              type="password"
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
              autoComplete="current-password"
            />
          </div>

          <div className={styles.actions}>
            <button
              className={styles.cancelButton}
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className={styles.submitButton}
              type="submit"
              disabled={submitting || !password.trim()}
            >
              Authenticate as Master
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

