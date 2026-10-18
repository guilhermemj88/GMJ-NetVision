'use client';

/**
 * Disponibilidade da aba BGP → Mitigação DDoS no cliente.
 *
 * Duas camadas, nesta ordem:
 *  1. decisão do BUILD (`isDdosMitigationUiEnabled()`), inlinada a partir da
 *     identidade da instalação + flag — evita "piscar" e funciona offline;
 *  2. confirmação em TEMPO DE EXECUÇÃO por `GET /installation` — corrige o caso
 *     de release construído em outra máquina/sem a flag.
 *
 * A rota é consultada UMA vez (sem polling, sem invalidação) e só quando o
 * build não habilitou o módulo. Falha de rede nunca liga o módulo: o padrão é o
 * que o build decidiu. Nada aqui autoriza ação — as rotas de mitigação da API
 * continuam exigindo sessão e o RBAC existente.
 */

import { useEffect, useState } from 'react';
import { isDdosMitigationUiEnabled } from './feature-flags';

/** Payload de `GET /installation` (somente os campos usados aqui). */
export interface InstallationPayload {
  installation?: { id?: string; source?: string; hostname?: string | null };
  modules?: { ddosMitigation?: { enabled?: boolean; reason?: string } };
}

/** Extrai a decisão do payload com validação defensiva (só `true` liga). */
export function ddosMitigationFromPayload(payload: unknown): boolean | null {
  if (!payload || typeof payload !== 'object') return null;
  const modules = (payload as InstallationPayload).modules;
  const entry = modules?.ddosMitigation;
  if (!entry || typeof entry.enabled !== 'boolean') return null;
  return entry.enabled;
}

/** Decide o modo efetivo: runtime (quando respondeu) vence o build. */
export function resolveDdosMitigationUiEnabled(
  buildEnabled: boolean,
  runtimeEnabled: boolean | null,
): boolean {
  return runtimeEnabled === null ? buildEnabled : runtimeEnabled;
}

export function useDdosMitigationUiEnabled(): boolean {
  const buildEnabled = isDdosMitigationUiEnabled();
  const [runtimeEnabled, setRuntimeEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (buildEnabled) return undefined;
    let active = true;
    void fetch('/installation', { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        const enabled = ddosMitigationFromPayload(payload);
        if (active && enabled !== null) setRuntimeEnabled(enabled);
      })
      .catch(() => {
        /* sem rede: mantém a decisão do build */
      });
    return () => {
      active = false;
    };
  }, [buildEnabled]);

  return resolveDdosMitigationUiEnabled(buildEnabled, runtimeEnabled);
}
