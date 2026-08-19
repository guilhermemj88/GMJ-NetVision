'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PublicView, PublicViewType } from '@gmj/shared';
import { Badge, Button } from '@gmj/ui';
import { Check, Copy, ExternalLink, Globe, Link2, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import {
  createPublicView,
  deletePublicView,
  getMaps,
  getPlaylists,
  listPublicViews,
  updatePublicView,
} from '@/lib/api';
import { useMapStore } from '@/store/map-store';

function publicUrl(type: PublicViewType, token: string): string {
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  return `${base}/view/${type.toLowerCase()}/${token}`;
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy copy path below.
    }
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

export function PublicLinksPanel() {
  const setPanel = useMapStore((state) => state.setPanel);
  const showToast = useMapStore((state) => state.showToast);
  const queryClient = useQueryClient();

  const { data: views = [] } = useQuery({ queryKey: ['public-views'], queryFn: listPublicViews });
  const { data: maps = [] } = useQuery({ queryKey: ['maps'], queryFn: getMaps });
  const { data: playlists = [] } = useQuery({ queryKey: ['playlists'], queryFn: getPlaylists });

  const [name, setName] = useState('NOC Principal');
  const [type, setType] = useState<PublicViewType>('NOC');
  const [mapId, setMapId] = useState('');
  const [playlistId, setPlaylistId] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['public-views'] });

  const createMutation = useMutation({
    mutationFn: () =>
      createPublicView({
        name,
        type,
        ...(type === 'MAP' ? { mapId: mapId || maps[0]?.id || null } : {}),
        ...(type === 'NOC' ? { playlistId: playlistId || playlists[0]?.id || null } : {}),
      }),
    onSuccess: () => {
      invalidate();
      showToast('Link público criado');
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updatePublicView(id, { enabled }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePublicView(id),
    onSuccess: invalidate,
  });

  const copy = async (view: PublicView) => {
    const url = publicUrl(view.type, view.token);
    const copiedNow = await copyText(url);
    if (copiedNow) {
      setCopied(view.token);
      showToast('Link copiado');
      window.setTimeout(() => setCopied((current) => (current === view.token ? null : current)), 2000);
    } else {
      showToast('Não foi possível copiar. Copie a URL manualmente.');
    }
  };

  const openLink = (view: PublicView) => {
    window.open(publicUrl(view.type, view.token), '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="panel-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setPanel(null)}>
      <section className="action-panel" role="dialog" aria-modal="true" aria-label="Links públicos">
        <header>
          <div>
            <span>COMPARTILHAMENTO</span>
            <h2>Links públicos</h2>
          </div>
          <button type="button" aria-label="Fechar" onClick={() => setPanel(null)}>
            ×
          </button>
        </header>
        <div className="panel-body">
          <div className="public-link-form">
            <label>
              Nome
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              Tipo
              <select value={type} onChange={(event) => setType(event.target.value as PublicViewType)}>
                <option value="NOC">NOC (rotação de mapas)</option>
                <option value="MAP">Mapa único</option>
              </select>
            </label>
            {type === 'MAP' ? (
              <label>
                Mapa
                <select value={mapId} onChange={(event) => setMapId(event.target.value)}>
                  {maps.map((map) => (
                    <option key={map.id} value={map.id}>
                      {map.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Playlist
                <select value={playlistId} onChange={(event) => setPlaylistId(event.target.value)}>
                  {playlists.map((playlist) => (
                    <option key={playlist.id} value={playlist.id}>
                      {playlist.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              variant="primary"
              disabled={createMutation.isPending || !name.trim()}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{' '}
              Criar link
            </Button>
          </div>

          <div className="public-link-list">
            {views.length === 0 && <p className="public-link-empty">Nenhum link público criado.</p>}
            {views.map((view) => {
              const url = publicUrl(view.type, view.token);
              return (
                <article key={view.id} className={`public-link-item ${view.enabled ? '' : 'is-disabled'}`}>
                  <div className="public-link-item__head">
                    <div className="public-link-item__icon">
                      {view.type === 'NOC' ? <Globe size={16} /> : <Link2 size={16} />}
                    </div>
                    <div className="public-link-item__copy">
                      <strong>{view.name}</strong>
                      <span>
                        Tipo: {view.type} · {view.enabled ? 'Ativo' : 'Desativado'}
                        {view.expiresAt ? ` · expira ${new Date(view.expiresAt).toLocaleDateString('pt-BR')}` : ''}
                      </span>
                    </div>
                    <Badge tone={view.enabled ? 'up' : 'down'}>{view.enabled ? 'ATIVO' : 'INATIVO'}</Badge>
                    <Button
                      compact
                      variant="ghost"
                      onClick={() => void copy(view)}
                      title="Copiar link"
                    >
                      {copied === view.token ? <Check size={14} /> : <Copy size={14} />}
                    </Button>
                    <Button
                      compact
                      variant="ghost"
                      onClick={() => openLink(view)}
                      title="Abrir link"
                    >
                      <ExternalLink size={14} />
                    </Button>
                    <Button
                      compact
                      variant="ghost"
                      onClick={() => toggleMutation.mutate({ id: view.id, enabled: !view.enabled })}
                      title={view.enabled ? 'Desativar' : 'Ativar'}
                    >
                      {view.enabled ? 'Desativar' : 'Ativar'}
                    </Button>
                    <Button
                      compact
                      variant="danger"
                      onClick={() => deleteMutation.mutate(view.id)}
                      title="Excluir"
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                  <input
                    className="public-link-item__url"
                    readOnly
                    value={url}
                    aria-label={`URL do link ${view.name}`}
                    onFocus={(event) => event.currentTarget.select()}
                    onClick={(event) => event.currentTarget.select()}
                  />
                </article>
              );
            })}
          </div>
        </div>
        <footer>
          <Button variant="ghost" onClick={() => setPanel(null)}>
            Fechar
          </Button>
        </footer>
      </section>
    </div>
  );
}
