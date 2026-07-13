import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import { useAuth } from '../auth/AuthProvider';
import { Brand } from '../components/Brand';
import { InlineAlert, Spinner } from '../components/Feedback';
import { errorMessage } from '../lib';

interface LocationState {
  from?: { pathname?: string };
}

const googleErrorMessages: Record<string, string> = {
  google: 'Google sign-in could not be completed. Please try again.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_domain: 'Sign-in with this email domain is not allowed.',
  google_unverified: 'Your Google account email address is not verified.',
  google_conflict: 'This email is already linked to a different Google account.',
};

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.71-1.57 2.68-3.89 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.42 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const authConfig = useQuery({
    queryKey: queryKeys.authConfig,
    queryFn: api.authConfig,
    staleTime: 5 * 60_000,
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const code = new URLSearchParams(location.search).get('error');
    if (code === null) return null;
    return googleErrorMessages[code] ?? 'Sign-in could not be completed. Please try again.';
  });
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
          {authConfig.data?.google && (
            <>
              <div className="auth-divider" role="separator">
                <span>or</span>
              </div>
              <a className="button secondary full-width oauth-google" href="/api/auth/google">
                <GoogleIcon />
                Continue with Google
              </a>
            </>
          )}
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
