import type { AuthUser } from '@gmj/shared';

export interface AuthUserRecord {
  id: string;
  username: string;
  email: string;
  name: string;
  role: AuthUser['role'];
  enabled: boolean;
  passwordHash: string;
}

export interface AuthRepository {
  findUserByLogin(identifier: string): Promise<AuthUserRecord | null>;
  findUserBySessionToken(token: string): Promise<AuthUserRecord | null>;
  findUserById(id: string): Promise<AuthUserRecord | null>;
  createSession(userId: string, expiresAt: Date): Promise<{ token: string }>;
  deleteSession(token: string): Promise<void>;
  createAdmin(input: {
    username: string;
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<AuthUserRecord>;
  createUser(input: {
    username: string;
    email: string;
    name: string;
    passwordHash: string;
    role: AuthUserRecord['role'];
    enabled?: boolean;
  }): Promise<AuthUserRecord>;
  updateUser(
    id: string,
    input: {
      email?: string;
      name?: string;
      role?: AuthUserRecord['role'];
      enabled?: boolean;
      passwordHash?: string;
    },
  ): Promise<AuthUserRecord | null>;
  listUsers(): Promise<AuthUserRecord[]>;
  countUsers(): Promise<number>;
  disconnect?(): Promise<void>;
}
