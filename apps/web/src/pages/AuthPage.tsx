import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { Brand } from '../components/Brand';
import { InlineAlert, Spinner } from '../components/Feedback';
import { errorMessage } from '../lib';

interface LocationState {
  from?: { pathname?: string };
}

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRegister = mode === 'register';

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (isRegister) await register(email.trim(), password);
      else await login(email.trim(), password);
      const state = location.state as LocationState | null;
      navigate(state?.from?.pathname ?? '/devices', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-intro" aria-label="About RelayDock">
        <Brand />
        <div className="auth-copy">
          <span className="eyebrow">YOUR MACHINES, WITHIN REACH</span>
          <h1>Pick up your terminal from anywhere.</h1>
          <p>
            Run trusted development actions, follow live output, and return to persistent
            sessions—without exposing your laptop to the internet.
          </p>
          <div className="connection-path" aria-label="RelayDock connection path">
            <span>Phone</span>
            <i aria-hidden="true" />
            <span>RelayDock</span>
            <i aria-hidden="true" />
            <span>Laptop</span>
          </div>
        </div>
        <p className="auth-footnote">
          Outbound connections only · Encrypted in transit · Self-hostable
        </p>
      </section>
      <section className="auth-form-wrap">
        <div className="auth-form-card">
          <span className="mobile-auth-brand">
            <Brand />
          </span>
          <p className="eyebrow">{isRegister ? 'CREATE YOUR DOCK' : 'WELCOME BACK'}</p>
          <h2>{isRegister ? 'Create an account' : 'Sign in to RelayDock'}</h2>
          <p className="muted">
            {isRegister
              ? 'Start securely connecting your development devices.'
              : 'Your active sessions are waiting.'}
          </p>
          {error && <InlineAlert tone="danger">{error}</InlineAlert>}
          <form className="form-stack" onSubmit={(event) => void handleSubmit(event)}>
            <label>
              Email address
              <input
                autoComplete="email"
                inputMode="email"
                name="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
              />
            </label>
            <label>
              Password
              <input
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                minLength={isRegister ? 12 : 1}
                name="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={isRegister ? 'At least 12 characters' : 'Your password'}
                required
              />
            </label>
            {isRegister && (
              <small className="field-hint">
                Use at least 12 characters and a unique password.
              </small>
            )}
            <button className="button primary full-width" type="submit" disabled={submitting}>
              {submitting && <Spinner />}
              {submitting
                ? isRegister
                  ? 'Creating account…'
                  : 'Signing in…'
                : isRegister
                  ? 'Create account'
                  : 'Sign in'}
            </button>
          </form>
          <p className="auth-switch">
            {isRegister ? 'Already have an account?' : 'New to RelayDock?'}{' '}
            <Link to={isRegister ? '/login' : '/register'}>
              {isRegister ? 'Sign in' : 'Create an account'}
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}
