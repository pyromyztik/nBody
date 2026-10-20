import React, { Component, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class RootErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Root render error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: '100dvh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            color: '#f87171',
            fontFamily: "'Segoe UI', system-ui, sans-serif",
            background: 'radial-gradient(circle at 20% 20%, #1b1d2b, #0b0c10 50%), #0b0c10',
            textAlign: 'center'
          }}
        >
          <div
            style={{
              maxWidth: 480,
              padding: 32,
              borderRadius: 16,
              background: 'rgba(15, 18, 28, 0.94)',
              border: '1px solid rgba(239, 68, 68, 0.35)',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)'
            }}
          >
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0 0 12px', color: '#f87171' }}>
              Application Render Error
            </h1>
            <p style={{ color: '#e2e8f0', fontSize: '0.95rem', margin: '0 0 16px', lineHeight: 1.5 }}>
              {this.state.error?.message || 'An unexpected runtime error occurred while loading the application.'}
            </p>
            <button
              type="button"
              onClick={() => {
                window.location.href = import.meta.env.BASE_URL || '/';
              }}
              style={{
                padding: '10px 24px',
                borderRadius: 8,
                border: 'none',
                background: '#38bdf8',
                color: '#0b1120',
                fontWeight: 700,
                fontSize: '0.95rem',
                cursor: 'pointer'
              }}
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
);
