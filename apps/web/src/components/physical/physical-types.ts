export type PhysicalSelection =
  | { kind: 'asset'; id: string }
  | { kind: 'port'; id: string }
  | { kind: 'connection'; id: string }
  | null;

export type PhysicalConnectionMode = 'hidden' | 'selected' | 'all';
