import { useState } from 'react';

export default function LoginPage({ onLogin }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const resp = await fetch('/api/hector-personal', {
        headers: { Authorization: `Bearer ${pw}` },
      });
      if (resp.ok) {
        localStorage.setItem('app_pw', pw);
        onLogin(pw);
      } else {
        setErr('Wrong password.');
      }
    } catch {
      setErr('Network error — check your connection.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: '#f9fafb', fontFamily: 'system-ui, sans-serif',
    }}>
      <form onSubmit={handleSubmit} style={{
        background: '#fff', padding: '2rem', borderRadius: '10px',
        boxShadow: '0 2px 20px #0001', minWidth: 320, maxWidth: 360, width: '100%',
      }}>
        <h2 style={{ margin: '0 0 0.25rem', fontSize: '1.2rem', fontWeight: 600 }}>
          Dawn&apos;s F2T Heat Map
        </h2>
        <p style={{ margin: '0 0 1.25rem', color: '#6b7280', fontSize: '0.875rem' }}>
          Enter the access password to continue.
        </p>
        <input
          type="password"
          placeholder="Password"
          value={pw}
          onChange={e => setPw(e.target.value)}
          style={{
            width: '100%', padding: '0.5rem 0.75rem',
            border: '1px solid #d1d5db', borderRadius: 6,
            fontSize: '1rem', boxSizing: 'border-box', outline: 'none',
          }}
          autoFocus
        />
        {err && (
          <div style={{ color: '#dc2626', fontSize: '0.85rem', marginTop: '0.5rem' }}>
            {err}
          </div>
        )}
        <button
          type="submit"
          disabled={loading || !pw}
          style={{
            marginTop: '1rem', width: '100%', padding: '0.55rem',
            background: loading || !pw ? '#93c5fd' : '#2563eb',
            color: '#fff', border: 'none', borderRadius: 6,
            fontSize: '1rem', cursor: loading || !pw ? 'default' : 'pointer',
            transition: 'background 0.15s',
          }}
        >
          {loading ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}
