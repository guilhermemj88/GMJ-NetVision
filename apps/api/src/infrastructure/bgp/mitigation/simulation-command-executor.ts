/**
 * Executor de SIMULACAO: apenas monta os comandos que SERIAM enviados.
 *
 * Proteção estrutural contra escrita acidental: esta classe NÃO possui método
 * de SSH, não recebe cliente, não importa ssh2 e nunca retorna nada além de
 * texto. Não existe `LiveCommandExecutor` nesta entrega.
 *
 * A mitigação é UM PAR de nodes: BOGONS (deny) primeiro e o node que aplica a
 * RT (permit) depois. Os nomes das prefix-lists vêm da configuração do motor —
 * nunca de Telegram/n8n.
 */

export interface CommandPreview {
  /** Comandos na ordem exata em que seriam aplicados (apenas texto). */
  commands: string[];
  safe: true;
}

export interface MitigationPairInput {
  bogonNode: number;
  mitigationNode: number;
}

export interface MitigationPairLabels {
  bogonPrefixList: string;
  targetPrefixList: string;
}

export class SimulationCommandExecutor {
  buildMitigation(
    policyName: string,
    pair: MitigationPairInput,
    rt: string,
    labels: MitigationPairLabels,
  ): CommandPreview {
    return {
      safe: true,
      commands: [
        'system-view',
        `route-policy ${policyName} deny node ${pair.bogonNode}`,
        ` if-match ip-prefix ${labels.bogonPrefixList}`,
        `route-policy ${policyName} permit node ${pair.mitigationNode}`,
        ` if-match ip-prefix ${labels.targetPrefixList}`,
        ` apply extcommunity rt ${rt} additive`,
        'commit',
      ],
    };
  }

  buildRecovery(policyName: string, pair: MitigationPairInput): CommandPreview {
    return {
      safe: true,
      commands: [
        'system-view',
        `undo route-policy ${policyName} node ${pair.bogonNode}`,
        `undo route-policy ${policyName} node ${pair.mitigationNode}`,
        'commit',
      ],
    };
  }
}
