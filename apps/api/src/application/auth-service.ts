import { createHash, randomBytes } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import type { AuthUser } from '@gmj/shared';
import type { AuthRepository, AuthUserRecord } from '../infrastructure/persistence/auth-repository';

const BCRYPT_COST = 12;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function toAuthUser(user: AuthUserRecord): AuthUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly sessionTtlDays: number,
  ) {}

  async login(
    identifier: string,
    password: string,
  ): Promise<{ token: string; user: AuthUser } | null> {
    const user = await this.repository.findUserByLogin(identifier.trim());
    if (!user || !user.enabled) return null;
    const valid = await compare(password, user.passwordHash);
    if (!valid) return null;
    const expiresAt = new Date(Date.now() + this.sessionTtlDays * 86_400_000);
    const { token } = await this.repository.createSession(user.id, expiresAt);
    return { token, user: toAuthUser(user) };
  }

  async userForToken(token: string | undefined): Promise<AuthUser | null> {
    if (!token) return null;
    const user = await this.repository.findUserBySessionToken(token);
    return user ? toAuthUser(user) : null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.repository.deleteSession(token);
  }

  /** Seeds a demo admin only when no user exists (used by demo mode). */
  async ensureDemoAdmin(password: string): Promise<void> {
    if ((await this.repository.countUsers()) > 0) return;
    const passwordHash = await hash(password, BCRYPT_COST);
    await this.repository.createAdmin({
      username: 'admin',
      email: 'admin@netvision.local',
      name: 'Administrador',
      passwordHash,
    });
  }

  /** Hashes a password for CLI-based user creation. */
  static async hashPassword(password: string): Promise<string> {
    return hash(password, BCRYPT_COST);
  }
}
