import { FormEvent, useEffect, useState } from 'react';

interface LoginProps {
  mode: 'local' | 'hip';
  onAuthenticated: () => void;
}

export default function Login({ mode, onAuthenticated }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError('');
  }, [mode]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('http://localhost:3001/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Login failed');
      onAuthenticated();
    } catch (loginError: any) {
      setError(loginError.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'hip') {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-body)' }}>
        <section className="card" style={{ width: 'min(420px, calc(100vw - 2rem))', padding: '2rem', textAlign: 'center' }}>
          <h1 style={{ marginTop: 0 }}>Sign in</h1>
          <p style={{ color: 'var(--text-muted)' }}>Continue with your HIP account.</p>
          {error && <p style={{ color: 'var(--danger-hover)' }}>{error}</p>}
          <button className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => {
            const returnTo = `${window.location.pathname}${window.location.search}`;
            window.location.assign(`http://localhost:3001/api/auth/login/hip?returnTo=${encodeURIComponent(returnTo)}`);
          }}>Continue to HIP</button>
        </section>
      </main>
    );
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-body)' }}>
      <form className="card" style={{ width: 'min(420px, calc(100vw - 2rem))', padding: '2rem' }} onSubmit={submit}>
        <h1 style={{ marginTop: 0 }}>Sign in</h1>
        <p style={{ color: 'var(--text-muted)' }}>Use your Forms Builder account.</p>
        {error && <p style={{ color: 'var(--danger-hover)' }}>{error}</p>}
        <label className="form-label" htmlFor="login-username">Username</label>
        <input id="login-username" className="form-input" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
        <label className="form-label" htmlFor="login-password" style={{ marginTop: '1rem' }}>Password</label>
        <input id="login-password" className="form-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
        <button className="btn" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: '1.5rem' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
