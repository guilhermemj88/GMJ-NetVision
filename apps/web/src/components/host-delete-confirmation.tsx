'use client';

import type { HostRecord } from '@gmj/shared';
import { Button } from '@gmj/ui';
import { LoaderCircle, Trash2, X } from 'lucide-react';

interface HostDeleteConfirmationProps {
  host: Pick<HostRecord, 'id' | 'hostname' | 'displayName' | 'mapCount'>;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function HostDeleteConfirmation({
  host,
  pending,
  error,
  onCancel,
  onConfirm,
}: HostDeleteConfirmationProps) {
  return (
    <div className="modal-backdrop">
      <section
        className="compact-modal host-delete-confirmation"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="host-delete-title"
        aria-describedby="host-delete-description"
      >
        <header>
          <Trash2 />
          <div>
            <span>EXCLUSÃO DO INVENTÁRIO</span>
            <h2 id="host-delete-title">Excluir este host?</h2>
          </div>
          <button
            type="button"
            aria-label="Fechar confirmação"
            disabled={pending}
            onClick={onCancel}
          >
            <X size={16} />
          </button>
        </header>
        <p id="host-delete-description">
          Esta ação removerá <strong>{host.displayName || host.hostname}</strong> do inventário e
          dos {host.mapCount === 1 ? 'mapa em que está presente' : 'mapas em que está presente'}.
          Nodes, enlaces e configurações exclusivas deste host também serão removidos.
        </p>
        {error && (
          <div className="form-error host-delete-confirmation__error" role="alert">
            {error}
          </div>
        )}
        <footer>
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            Cancelar
          </Button>
          <Button variant="danger" disabled={pending || !host.id.trim()} onClick={onConfirm}>
            {pending ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
            {pending ? 'Excluindo…' : 'Excluir host'}
          </Button>
        </footer>
      </section>
    </div>
  );
}
