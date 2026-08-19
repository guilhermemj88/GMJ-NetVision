import { createHash, randomBytes } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import type { AuthUser, CreateUserInput, UpdateUserInput, UserAccount } from '@gmj/shared';
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

function toUserAccount(user: AuthUserRecord): UserAccount {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    role: user.role,
    enabled: user.enabled,
  };
}

export class UserAlreadyExistsError extends Error {
  constructor() {
    super('Usuário ou e-mail já cadastrado');
    this.name = 'UserAlreadyExistsError';
  }
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

  /** Seeds a default admin only when no user exists yet. */
  async ensureDefaultAdmin(input: {
    username: string;
    email: string;
    name: string;
    password: string;
  }): Promise<void> {
    if ((await this.repository.countUsers()) > 0) return;
    const passwordHash = await hash(input.password, BCRYPT_COST);
    await this.repository.createAdmin({
      username: input.username,
      email: input.email,
      name: input.name,
      passwordHash,
    });
  }

  async listUsers(): Promise<UserAccount[]> {
    const users = await this.repository.listUsers();
    return users.map(toUserAccount);
  }

  async createUser(input: CreateUserInput): Promise<UserAccount> {
    const username = input.username.trim();
    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    if (
      (await this.repository.findUserByLogin(username)) ||
      (await this.repository.findUserByLogin(email))
    ) {
      throw new UserAlreadyExistsError();
    }
    const passwordHash = await hash(input.password, BCRYPT_COST);
    const user = await this.repository.createUser({
      username,
      email,
      name,
      passwordHash,
      role: input.role,
      enabled: true,
    });
    return toUserAccount(user);
  }

  async updateUser(id: string, input: UpdateUserInput): Promise<UserAccount | null> {
    const existing = await this.repository.findUserById(id);
    if (!existing) return null;

    const email = input.email?.trim().toLowerCase();
    if (email && email !== existing.email.toLowerCase()) {
      const byEmail = await this.repository.findUserByLogin(email);
      if (byEmail && byEmail.id !== id) throw new UserAlreadyExistsError();
    }

    const passwordHash = input.password ? await hash(input.password, BCRYPT_COST) : undefined;
    const updated = await this.repository.updateUser(id, {
      ...(input.email !== undefined ? { email: input.email.trim().toLowerCase() } : {}),
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(passwordHash !== undefined ? { passwordHash } : {}),
    });
    return updated ? toUserAccount(updated) : null;
  }

  async setUserPassword(id: string, password: string): Promise<boolean> {
    const passwordHash = await hash(password, BCRYPT_COST);
    const updated = await this.repository.updateUser(id, { passwordHash });
    return Boolean(updated);
  }

  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const user = await this.repository.findUserById(userId);
    if (!user || !user.enabled) return false;
    const valid = await compare(currentPassword, user.passwordHash);
    if (!valid) return false;
    const passwordHash = await hash(newPassword, BCRYPT_COST);
    await this.repository.updateUser(userId, { passwordHash });
    return true;
  }

  /** Hashes a password for CLI-based user creation. */
  static async hashPassword(password: string): Promise<string> {
    return hash(password, BCRYPT_COST);
  }
}
