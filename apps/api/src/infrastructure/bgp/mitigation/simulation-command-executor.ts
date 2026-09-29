/**
 * Executor de SIMULAÇÃO: apenas monta os comandos que SERIAM enviados.
 *
 * Proteção estrutural contra escrita acidental: esta classe NÃO possui método
 * de SSH, não recebe cliente, não importa ssh2 e nunca retorna nada além de
 * texto. Não existe `LiveCommandExecutor` nesta entrega.
 */

export interface CommandPreview {
  /** Comandos na ordem exata em que seriam aplicados (apenas texto). */
  commands: string[];
  safe: true;
}

export class SimulationCommandExecutor {
  buildMitigation(policyName: string, node: number, rt: string): CommandPreview {
    return {
      safe: true,
      commands: [
        'system-view',
        `route-policy ${policyName} permit node ${node}`,
        ` apply extcommunity rt ${rt} additive`,
        'commit',
      ],
    };
  }

  buildRecovery(policyName: string, node: number): CommandPreview {
    return {
      safe: true,
      commands: ['system-view', `undo route-policy ${policyName} permit node ${node}`, 'commit'],
    };
  }
}
