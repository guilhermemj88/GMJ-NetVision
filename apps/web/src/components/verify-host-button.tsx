'use client';

import { useState } from 'react';
import { Button } from '@gmj/ui';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { pollHost } from '@/lib/api';
import { describePollFeedback, type PollFeedbackTone } from '@/lib/telemetry-feedback';
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
    client.invalidateQueries({ queryKey: ['host-mpls', hostId] }),
    client.invalidateQueries({ queryKey: ['host-mpls-events', hostId] }),
  ]);
}

const FEEDBACK_CLASS: Record<PollFeedbackTone, string> = {
  ok: 'is-success',
  partial: 'is-partial',
  baseline: 'is-partial',
  warning: 'is-partial',
};

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
  const [feedback, setFeedback] = useState<{ message: string; tone: PollFeedbackTone } | null>(null);
  const mutation = useMutation({
    mutationFn: () => pollHost(hostId),
    onMutate: () => setFeedback(null),
    onSuccess: async (result) => {
      await refreshHostQueries(client, hostId);
      /**
       * F9.6: a mensagem vem do resultado REAL do poll (telemetria/óptico).
       * "Verificado" quando nada novo foi coletado deixava o operador sem saber
       * que precisava esperar o intervalo mínimo dos contadores.
       */
      const outcome = describePollFeedback(result);
      const verified = result.interfacesChecked > 0
        ? ` · ${result.interfacesChecked} interfaces verificadas`
        : '';
      const message = verified
        ? `${outcome.message.replace(/\.$/, '')}${verified}`
        : outcome.message;
      setFeedback({ message, tone: outcome.tone });
      showToast(message);
    },
    onError: () => {
      const message = 'Falha ao verificar equipamento';
      setFeedback({ message, tone: 'warning' });
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
        <small
          className={mutation.isError ? 'is-error' : FEEDBACK_CLASS[feedback.tone]}
          role="status"
        >
          {feedback.message}
        </small>
      )}
    </div>
  );
}
