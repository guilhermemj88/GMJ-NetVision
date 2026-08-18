import { PrismaClient } from '../../generated/prisma/index.js';
import { hashToken, randomToken } from '../../application/auth-service';
import type { AuthRepository, AuthUserRecord } from './auth-repository';

function fromRow(row: {
  id: string;
  username: string;
  email: string;
  name: string;
  role: string;
  enabled: boolean;
  passwordHash: string;
}): AuthUserRecord {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    name: row.name,
    role: row.role as AuthUserRecord['role'],
    enabled: row.enabled,
    passwordHash: row.passwordHash,
  };
}

export class PrismaAuthRepository implements AuthRepository {
  private readonly prisma = new PrismaClient();

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async findUserByLogin(identifier: string): Promise<AuthUserRecord | null> {
    const row = await this.prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: identifier, mode: 'insensitive' } },
          { email: { equals: identifier, mode: 'insensitive' } },
        ],
      },
    });
    return row ? fromRow(row) : null;
  }

  async findUserBySessionToken(token: string): Promise<AuthUserRecord | null> {
    const row = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!row || row.expiresAt.getTime() < Date.now()) return null;
    return row.user.enabled ? fromRow(row.user) : null;
  }

  async createSession(userId: string, expiresAt: Date): Promise<{ token: string }> {
    const token = randomToken();
    await this.prisma.session.create({
      data: { tokenHash: hashToken(token), userId, expiresAt },
    });
    return { token };
  }

  async deleteSession(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }

  async createAdmin(input: {
    username: string;
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<AuthUserRecord> {
    const row = await this.prisma.user.upsert({
      where: { username: input.username },
      create: {
        username: input.username,
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        role: 'ADMIN',
        enabled: true,
      },
      update: {
        email: input.email,
        name: input.name,
        passwordHash: input.passwordHash,
        role: 'ADMIN',
        enabled: true,
      },
    });
    return fromRow(row);
  }

  async countUsers(): Promise<number> {
    return this.prisma.user.count();
  }
}
