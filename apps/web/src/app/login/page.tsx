'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, LockKeyhole, UserRound } from 'lucide-react';
import { login } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!identifier.trim() || !password) return;
    setPending(true);
    setError(null);
    try {
      await login({ usernameOrEmail: identifier.trim(), password });
      router.replace('/');
    } catch {
      setError('Usuário ou senha inválidos.');
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="brand login-card__brand">
          <span className="brand__mark">
            <span />
            <span />
            <span />
          </span>
          <div>
            <strong>GMJ</strong>
            <span>NETVISION</span>
          </div>
        </div>
        <h1>Entrar no NetVision</h1>
        <p>Autentique-se para acessar mapas, inventário e configurações.</p>
        <label>
          <span>Usuário ou e-mail</span>
          <div className="login-card__field">
            <UserRound size={15} />
            <input
              autoFocus
              autoComplete="username"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="admin"
            />
          </div>
        </label>
        <label>
          <span>Senha</span>
          <div className="login-card__field">
            <LockKeyhole size={15} />
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
            />
          </div>
        </label>
        {error && <div className="login-card__error">{error}</div>}
        <button
          type="submit"
          className="nv-button nv-button--primary login-card__submit"
          disabled={pending || !identifier.trim() || !password}
        >
          {pending ? <LoaderCircle className="spin" size={15} /> : null} Entrar
        </button>
      </form>
    </main>
  );
}
