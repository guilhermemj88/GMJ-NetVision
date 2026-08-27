import { PrismaClient } from '../../generated/prisma/index.js';
import type { PppReadingInput, PppRepository } from './ppp-repository';

export class PrismaPppRepository implements PppRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async saveReading(hostId: string, input: PppReadingInput): Promise<void> {
    await this.prisma.device.update({
      where: { id: hostId },
      data: {
        pppSupported: input.supported,
        pppOnline: Math.max(0, Math.trunc(input.online)),
        pppUpdatedAt: input.updatedAt,
        pppSource: input.source,
      },
    });
  }

  async markUnsupported(hostId: string, _at: Date): Promise<void> {
    await this.prisma.device.update({
      where: { id: hostId },
      data: {
        pppSupported: false,
        pppOnline: 0,
        pppUpdatedAt: null,
        pppSource: null,
      },
    });
  }

  async saveFailure(_hostId: string, _at: Date, _safeMessage: string): Promise<void> {
    // A failed collection must never erase the last valid reading. Nothing is
    // persisted here on purpose: pppOnline/pppUpdatedAt keep their last value.
  }
}
