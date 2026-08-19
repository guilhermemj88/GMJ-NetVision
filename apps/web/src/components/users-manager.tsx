'use client';

import { useState } from 'react';
import { Badge, Button } from '@gmj/ui';
import { KeyRound, LoaderCircle, Plus, ShieldCheck, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role, UserAccount } from '@gmj/shared';
import {
  changeOwnPassword,
  createUser,
  listUsers,
  setUserPassword,
  updateUser,
} from '@/lib/api';
import { useMapStore } from '@/store/map-store';

const ROLES: Array<{ value: Role; label: string }> = [
  { value: 'ADMIN', label: 'Administrador' },
  { value: 'OPERATOR', label: 'Operador' },
  { value: 'VIEWER', label: 'Visualizador' },
];

function roleLabel(role: Role): string {
  return ROLES.find((item) => item.value === role)?.label ?? role;
}

export function UsersPanel() {
  const setPanel = useMapStore((state) => state.setPanel);
  const queryClient = useQueryClient();
  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: listUsers,
  });

  const createMutation = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const [form, setForm] = useState({
    username: '',
    email: '',
    name: '',
    password: '',
    role: 'VIEWER' as Role,
  });
  const [createError, setCreateError] = useState<string | null>(null);

  const submitCreate = async () => {
    setCreateError(null);
    try {
      await createMutation.mutateAsync(form);
      setForm({ username: '', email: '', name: '', password: '', role: 'VIEWER' });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Falha ao criar usuário');
    }
  };

  return (
    <div
      className="panel-overlay"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && setPanel(null)}
    >
      <section className="action-panel" role="dialog" aria-modal="true" aria-label="Usuários e senhas">
        <header>
          <div>
            <span>ADMINISTRAÇÃO</span>
            <h2>Usuários e senhas</h2>
          </div>
          <button type="button" aria-label="Fechar" onClick={() => setPanel(null)}>
            <X size={18} />
          </button>
        </header>

        <div className="panel-body settings-panel">
          <OwnPasswordSection />

          <h3>CRIAR NOVO USUÁRIO</h3>
          <div className="form-grid form-grid--device">
            <label>
              Usuário
              <input
                autoComplete="off"
                value={form.username}
                onChange={(event) => setForm((state) => ({ ...state, username: event.target.value }))}
                placeholder="ex.: operador1"
              />
            </label>
            <label>
              Nome completo
              <input
                value={form.name}
                onChange={(event) => setForm((state) => ({ ...state, name: event.target.value }))}
                placeholder="ex.: Operador de NOC"
              />
            </label>
            <label>
              E-mail
              <input
                type="email"
                autoComplete="off"
                value={form.email}
                onChange={(event) => setForm((state) => ({ ...state, email: event.target.value }))}
                placeholder="operador@netvision.local"
              />
            </label>
            <label>
              Senha inicial
              <input
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(event) => setForm((state) => ({ ...state, password: event.target.value }))}
                placeholder="mínimo 6 caracteres"
              />
            </label>
            <label>
              Perfil
              <select
                value={form.role}
                onChange={(event) => setForm((state) => ({ ...state, role: event.target.value as Role }))}
              >
                {ROLES.map((role) => (
                  <option key={role.value} value={role.value}>
                    {role.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="users-create-actions">
              <Button
                variant="primary"
                disabled={createMutation.isPending || !form.username || !form.email || !form.name || !form.password}
                onClick={() => void submitCreate()}
              >
                {createMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
                Criar usuário
              </Button>
            </div>
          </div>
          {createError && <p className="users-error">{createError}</p>}

          <h3>USUÁRIOS CADASTRADOS</h3>
          {isLoading ? (
            <div className="users-empty">
              <LoaderCircle className="spin" size={20} />
              Carregando usuários…
            </div>
          ) : users.length === 0 ? (
            <div className="users-empty">Nenhum usuário cadastrado.</div>
          ) : (
            <div className="users-list">
              {users.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  onChanged={() => void queryClient.invalidateQueries({ queryKey: ['users'] })}
                />
              ))}
            </div>
          )}

          <div className="panel-note">
            <ShieldCheck size={17} />
            <span>
              Apenas administradores podem criar usuários e redefinir senhas. Senhas são
              armazenadas com hash bcrypt e nunca são exibidas.
            </span>
          </div>
        </div>

        <footer>
          <Button variant="primary" onClick={() => setPanel(null)}>
            Concluído
          </Button>
        </footer>
      </section>
    </div>
  );
}

function OwnPasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => changeOwnPassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setMessage('Senha alterada com sucesso.');
      setError(null);
    },
    onError: (err) => {
      setMessage(null);
      setError(err instanceof Error ? err.message : 'Falha ao alterar senha');
    },
  });

  return (
    <>
      <h3>MINHA SENHA</h3>
      <div className="form-grid form-grid--device">
        <label>
          Senha atual
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </label>
        <label>
          Nova senha
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </label>
        <div className="users-create-actions">
          <Button
            variant="secondary"
            disabled={mutation.isPending || !current || next.length < 6}
            onClick={() => void mutation.mutate()}
          >
            {mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}
            Alterar minha senha
          </Button>
        </div>
      </div>
      {message && <p className="users-success">{message}</p>}
      {error && <p className="users-error">{error}</p>}
    </>
  );
}

function UserRow({ user, onChanged }: { user: UserAccount; onChanged: () => void }) {
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: (input: Parameters<typeof updateUser>[1]) => updateUser(user.id, input),
    onSuccess: () => {
      setMessage('Usuário atualizado.');
      setError(null);
      onChanged();
    },
    onError: (err) => {
      setMessage(null);
      setError(err instanceof Error ? err.message : 'Falha ao atualizar usuário');
    },
  });

  const passwordMutation = useMutation({
    mutationFn: () => setUserPassword(user.id, password),
    onSuccess: () => {
      setPassword('');
      setMessage('Senha redefinida.');
      setError(null);
    },
    onError: (err) => {
      setMessage(null);
      setError(err instanceof Error ? err.message : 'Falha ao redefinir senha');
    },
  });

  const pending = updateMutation.isPending || passwordMutation.isPending;

  return (
    <div className="user-row">
      <div className="user-row__identity">
        <strong>{user.name}</strong>
        <span>{user.username}</span>
        <small>{user.email}</small>
      </div>
      <Badge tone={user.enabled ? 'info' : 'neutral'}>{user.enabled ? 'ATIVO' : 'INATIVO'}</Badge>
      <select
        value={user.role}
        disabled={pending}
        onChange={(event) => {
          setMessage(null);
          setError(null);
          void updateMutation.mutate({ role: event.target.value as Role });
        }}
      >
        {ROLES.map((role) => (
          <option key={role.value} value={role.value}>
            {role.label}
          </option>
        ))}
      </select>
      <input
        type="password"
        autoComplete="new-password"
        placeholder="Nova senha"
        value={password}
        disabled={pending}
        onChange={(event) => setPassword(event.target.value)}
      />
      <Button
        compact
        variant="secondary"
        disabled={pending || password.length < 6}
        onClick={() => void passwordMutation.mutate()}
      >
        Redefinir
      </Button>
      <Button
        compact
        variant="ghost"
        disabled={pending}
        onClick={() => void updateMutation.mutate({ enabled: !user.enabled })}
      >
        {user.enabled ? 'Desativar' : 'Ativar'}
      </Button>
      {message && <span className="users-success">{message}</span>}
      {error && <span className="users-error">{error}</span>}
    </div>
  );
}
