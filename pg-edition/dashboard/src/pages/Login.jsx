import { useEffect, useState } from 'react';
import { api, setToken, API_BASE } from '../api.js';
import { ErrorBox } from '../components/ui.jsx';

export default function Login({ onLogin }) {
  const [setup, setSetup] = useState(null);
  const [form, setForm] = useState({ email: '', password: '', name: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/auth/status').then((r) => setSetup(r.setupRequired)).catch((e) => {
      setError(new Error(`Cannot reach the API server${API_BASE ? ` at ${API_BASE}` : ''}: ${e.message}`));
      setSetup(false);
    });
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api(setup ? '/auth/setup' : '/auth/login', { method: 'POST', body: form });
      setToken(r.token);
      onLogin(r.admin);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="card auth-card stack" onSubmit={submit}>
        <div className="brand"><img src="/favicon.svg" alt="" />EmpMonitor</div>
        <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
          {setup ? 'Create the first administrator account' : 'Sign in to your dashboard'}
        </p>
        <ErrorBox error={error} />
        {setup && (
          <label className="field">Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="name" />
          </label>
        )}
        <label className="field">Email
          <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="username" />
        </label>
        <label className="field">Password
          <input type="password" required minLength={setup ? 8 : 1} value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete={setup ? 'new-password' : 'current-password'} />
        </label>
        <button className="primary" disabled={busy || setup === null}>{setup ? 'Create account' : 'Sign in'}</button>
      </form>
    </div>
  );
}
