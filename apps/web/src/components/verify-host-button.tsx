'use client';

import { useState } from 'react';
import { Button } from '@gmj/ui';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { pollHost } from '@/lib/api';
import { useMapStore } from '@/store/map-store';

export async function refreshHostQueries(client: QueryClient, hostId: string): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['hosts'] }),
    client.invalidateQueries({ queryKey: ['host', hostId] }),
    client.invalidateQueries({ queryKey: ['interfaces', hostId] }),
    client.invalidateQueries({ queryKey: ['interface-search'] }),
    client.invalidateQueries({ queryKey: ['map'] }),
    client.invalidateQueries({ queryKey: ['maps'] }),
    client.invalidateQueries({ queryKey: ['history'] }),
    client.invalidateQueries({ queryKey: ['optical-history'] }),
  ]);
}

export function VerifyHostButton({
  hostId,
  enabled,
  compact = false,
}: {
  hostId: string;
  enabled: boolean;
  compact?: boolean;
}) {
  const client = useQueryClient();
  const showToast = useMapStore((state) => state.showToast);
  const [feedback, setFeedback] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => pollHost(hostId),
    onMutate: () => setFeedback(null),
    onSuccess: async (result) => {
      await refreshHostQueries(client, hostId);
      const message =
        result.interfacesChecked > 0
          ? `Equipamento atualizado com sucesso · ${result.interfacesChecked} interfaces verificadas`
          : 'Equipamento atualizado com sucesso';
      setFeedback(message);
      showToast(message);
    },
    onError: () => {
      const message = 'Falha ao verificar equipamento';
      setFeedback(message);
      showToast(message);
    },
  });
  const label = mutation.isPending
    ? 'VERIFICANDO...'
    : mutation.isSuccess
      ? 'VERIFICADO AGORA'
      : 'VERIFICAR AGORA';

  return (
    <div className="verify-host-action">
      <Button
        compact={compact}
        variant="secondary"
        disabled={!enabled || mutation.isPending}
        onClick={() => mutation.mutate()}
        aria-label={`Verificar agora o equipamento ${hostId}`}
        title={enabled ? 'Executar polling imediato do equipamento' : 'SNMP desabilitado'}
      >
        {mutation.isPending ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
        {label}
      </Button>
      {feedback && (
        <small className={mutation.isError ? 'is-error' : 'is-success'} role="status">
          {feedback}
        </small>
      )}
    </div>
  );
}
