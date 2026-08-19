import type { AuthRepository, AuthUserRecord } from './auth-repository';
import { hashToken, randomToken } from '../../application/auth-service';

interface StoredSession {
  userId: string;
  expiresAt: Date;
}

/**
 * In-memory auth repository used by demo mode and the API test suite. Sessions
 * and users live only for the lifetime of the process, mirroring how the demo
 * map repository keeps maps in memory.
 */
export class DemoAuthRepository implements AuthRepository {
  private readonly users = new Map<string, AuthUserRecord>();
  private readonly sessions = new Map<string, StoredSession>();

  async findUserByLogin(identifier: string): Promise<AuthUserRecord | null> {
    const normalized = identifier.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.username.toLowerCase() === normalized || user.email.toLowerCase() === normalized) {
        return user;
      }
    }
    return null;
  }

  async findUserBySessionToken(token: string): Promise<AuthUserRecord | null> {
    const session = this.sessions.get(hashToken(token));
    if (!session || session.expiresAt.getTime() < Date.now()) return null;
    const user = this.users.get(session.userId);
    return user && user.enabled ? user : null;
  }

  async findUserById(id: string): Promise<AuthUserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async createSession(userId: string, expiresAt: Date): Promise<{ token: string }> {
    const token = randomToken();
    this.sessions.set(hashToken(token), { userId, expiresAt });
    return { token };
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(hashToken(token));
  }

  async createAdmin(input: {
    username: string;
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<AuthUserRecord> {
    const existing = this.users.get(input.username) ?? this.users.get(input.email);
    if (existing) {
      existing.email = input.email;
      existing.name = input.name;
      existing.passwordHash = input.passwordHash;
      existing.role = 'ADMIN';
      existing.enabled = true;
      return existing;
    }
    const user: AuthUserRecord = {
      id: `user-${input.username}`,
      username: input.username,
      email: input.email,
      name: input.name,
      role: 'ADMIN',
      enabled: true,
      passwordHash: input.passwordHash,
    };
    this.users.set(user.id, user);
    return user;
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async listUsers(): Promise<AuthUserRecord[]> {
    return [...this.users.values()].sort((left, right) =>
      left.username.localeCompare(right.username, 'pt-BR'),
    );
  }

  async createUser(input: {
    username: string;
    email: string;
    name: string;
    passwordHash: string;
    role: AuthUserRecord['role'];
    enabled?: boolean;
  }): Promise<AuthUserRecord> {
    const user: AuthUserRecord = {
      id: `user-${input.username}`,
      username: input.username,
      email: input.email,
      name: input.name,
      role: input.role,
      enabled: input.enabled ?? true,
      passwordHash: input.passwordHash,
    };
    this.users.set(user.id, user);
    return user;
  }

  async updateUser(
    id: string,
    input: {
      email?: string;
      name?: string;
      role?: AuthUserRecord['role'];
      enabled?: boolean;
      passwordHash?: string;
    },
  ): Promise<AuthUserRecord | null> {
    const user = this.users.get(id);
    if (!user) return null;
    if (input.email !== undefined) user.email = input.email;
    if (input.name !== undefined) user.name = input.name;
    if (input.role !== undefined) user.role = input.role;
    if (input.enabled !== undefined) user.enabled = input.enabled;
    if (input.passwordHash !== undefined) user.passwordHash = input.passwordHash;
    return user;
  }
}
