# Bootstrap do catálogo físico

O YAML versionado é copiado pelo build para `dist/catalog`. Toda embalagem futura precisa incluir esse recurso e validar seu hash. A ausência do arquivo já causou uso indevido do fallback em produção; bundle isolado não é pacote completo.

O lote `syncCatalog` usa uma transação PostgreSQL com advisory lock. Falha de identidade nominal ou estrutura dependente desfaz todo o lote. SYSTEM é identificado por catalogKey; CUSTOM não é apropriado por nome. Não há exclusão/reset, nem compensação automática dos templates criados por um boot antigo. Retry e duas inicializações simultâneas foram testados em PostgreSQL descartável.

Metadados SYSTEM idênticos não recebem nova atualização. Mudanças declaradas no catálogo ainda exigem revisão operacional; transação não significa ausência de efeitos. Ver [plano de estabilização](../../../../../docs/PHASE01_STABILIZATION.md).
