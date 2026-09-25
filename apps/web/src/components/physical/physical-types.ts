export type PhysicalSelection =
  | { kind: 'asset'; id: string }
  | { kind: 'port'; id: string }
  | { kind: 'connection'; id: string }
  /** Sugestão LLDP — `id` é o adjacencyId escolhido do par. */
  | { kind: 'lldp'; id: string }
  | null;

export type PhysicalConnectionMode = 'hidden' | 'selected' | 'all';

/**
 * Modo de visualização do rack.
 *
 * - `REAL`: imagens reais / front image / chassis image (comportamento de sempre);
 * - `TECHNICAL`: desenho técnico esquemático — outra camada de renderização,
 *   sem modelo de dados paralelo. Nesta fase só os modelos com desenho técnico
 *   declarado trocam de aparência; os demais continuam em `REAL`.
 */
export type PhysicalVisualMode = 'REAL' | 'TECHNICAL';
