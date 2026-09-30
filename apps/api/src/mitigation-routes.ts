import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser, BgpPeerDetail } from '@gmj/shared';
import type { BgpMitigationService } from './infrastructure/bgp/mitigation/mitigation-service';
import {
  MITIGATION_COMMAND_ACTIONS,
  type MitigationCommandService,
} from './infrastructure/bgp/mitigation/mitigation-command-service';

// API REST da mitigacao DDoS (SIMULATION_ONLY).
//
// Nao existe endpoint generico de execucao: a simulacao devolve texto de preview,
// nunca um caminho para enviar comando ao Huawei. O PATCH aceita apenas os
// campos administrativos seguros (override de banda, enabled, mode) e rejeita
// qualquer outro campo por schema estrito.

const profileParams = z.object({ id: z.string().min(1).max(160) });

const peerParams = z.object({ peerId: z.string().min(1).max(160) });

const patchSchema = z
  .object({
    bandwidthOverrideBps: z
      .union([z.string().regex(/^\d{1,20}$/, 'Banda deve ser um inteiro em bps'), z.null()])
      .optional(),
    enabled: z.boolean().optional(),
    mode: z.enum(['DISABLED', 'ALERT_ONLY', 'AUTO']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Informe ao menos um campo para atualizar',
  });

const discoverSchema = z
  .object({
    deviceId: z.string().min(1).max(160).optional(),
    deviceIds: z.array(z.string().min(1).max(160)).min(1).max(5).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.deviceId) || Boolean(value.deviceIds?.length), {
    message: 'Selecione um equipamento para descobrir',
  });

const simulateSchema = z
  .object({
    simulatedTrafficBps: z.string().regex(/^\d{1,20}$/, 'Trafego deve ser um inteiro em bps'),
    samples: z.number().int().min(1).max(100),
    simulatedPrefixCount: z.number().int().min(0).max(10_000_000).nullable().optional(),
  })
  .strict();

/** Comando da UI: a acao e o perfil; nada de CLI/node/RT vindo do cliente. */
const commandSchema = z
  .object({
    requestId: z.string().min(1).max(160),
    action: z.enum(MITIGATION_COMMAND_ACTIONS),
  })
  .strict();

const limitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Exclusao administrativa do target ("nunca mitigar este peer").
 * `excluded=false` limpa motivo/observacao (reabilitacao).
 */
const exclusionSchema = z
  .object({
    excluded: z.boolean(),
    reason: z.enum(['UPLINK', 'TRANSIT', 'IX', 'BACKBONE', 'MANUAL']).optional(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();

export interface MitigationRouteDependencies {
  service: BgpMitigationService;
  /** Mesma instancia usada pelo inbound do n8n (uma unica camada de servico). */
  commands?: MitigationCommandService;
  /**
   * Resolve a identidade do peer BGP. Necessario apenas para a exclusao
   * preventiva por peer (endpoint independente de profile).
   */
  peers?: { getPeerDetail(peerId: string): Promise<BgpPeerDetail | null> };
  currentUser?: (request: FastifyRequest) => Promise<AuthUser | null>;
}

export function registerMitigationRoutes(
  app: FastifyInstance,
  dependencies: MitigationRouteDependencies,
): void {
  const { service, currentUser, commands, peers } = dependencies;

  // Leitura: mesma exposicao do BGP (protegida pelo hook global de autenticacao).
  app.get('/api/bgp/mitigation/health', async () => service.health());

  app.get('/api/bgp/mitigation/profiles', async () => service.listProfiles());

  app.get('/api/bgp/mitigation/profiles/:id', async (request, reply) => {
    const { id } = profileParams.parse(request.params);
    const profile = await service.getProfile(id);
    if (!profile) return reply.code(404).send({ message: 'Perfil de mitigacao nao encontrado' });
    return profile;
  });

  app.get('/api/bgp/mitigation/simulations', async (request) => {
    const { limit } = limitSchema.parse(request.query);
    return service.listSimulations(limit);
  });

  app.get('/api/bgp/mitigation/events', async (request) => {
    const { limit } = limitSchema.parse(request.query);
    return service.listEvents(limit);
  });

  // Escrita: exige operador autenticado.
  const requireUser = async (
    request: FastifyRequest,
    reply: { code: (status: number) => { send: (payload: unknown) => unknown } },
  ): Promise<AuthUser | null> => {
    const user = (await currentUser?.(request)) ?? null;
    if (!user) {
      reply.code(401).send({ message: 'Nao autenticado' });
      return null;
    }
    return user;
  };

  app.post('/api/bgp/mitigation/discover', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return undefined;
    const payload = discoverSchema.parse(request.body ?? {});
    const deviceIds = payload.deviceIds ?? (payload.deviceId ? [payload.deviceId] : []);
    return service.discover(deviceIds);
  });

  app.post('/api/bgp/mitigation/profiles/:id/simulate', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return undefined;
    const { id } = profileParams.parse(request.params);
    const payload = simulateSchema.parse(request.body ?? {});
    // exactOptionalPropertyTypes: campos opcionais so entram quando presentes.
    const simulation = await service.simulate(id, {
      simulatedTrafficBps: payload.simulatedTrafficBps,
      samples: payload.samples,
      ...(payload.simulatedPrefixCount === undefined
        ? {}
        : { simulatedPrefixCount: payload.simulatedPrefixCount }),
    });
    if (!simulation) return reply.code(404).send({ message: 'Perfil de mitigacao nao encontrado' });
    return simulation;
  });

  // Comando da UI: sessao normal do NetVision + delegacao para o MESMO
  // MitigationCommandService que o n8n usa (sem logica paralela).
  if (commands) {
    app.post('/api/bgp/mitigation/profiles/:id/command', async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return undefined;
      const { id } = profileParams.parse(request.params);
      const payload = commandSchema.parse(request.body ?? {});
      return commands.execute({ ...payload, profileId: id });
    });
  }

  // Exclusao PREVENTIVA por PEER BGP ("nunca mitigar este peer"): vale mesmo
  // quando o peer NAO tem profile de mitigacao (uplink/transit/IX/backbone sem
  // banda declarada). Persistencia pura: sem discovery e sem SSH.
  if (peers) {
    app.patch('/api/bgp/peers/:peerId/mitigation-exclusion', async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return undefined;
      const { peerId } = peerParams.parse(request.params);
      const payload = exclusionSchema.parse(request.body ?? {});
      const peer = await peers.getPeerDetail(peerId);
      if (!peer) return reply.code(404).send({ message: 'Peer BGP nao encontrado' });
      return service.setPeerMitigationExclusion({
        peerId: peer.id,
        deviceId: peer.deviceId,
        peerAddress: peer.peerAddress,
        addressFamily: peer.addressFamily,
        interfaceId: peer.interface?.id ?? null,
        excluded: payload.excluded,
        ...(payload.reason === undefined ? {} : { reason: payload.reason }),
        ...(payload.note === undefined ? {} : { note: payload.note ?? null }),
      });
    });
  }

  // Exclusao administrativa da mitigacao: configuracao pura (sem discovery,  // sem SSH). Vale para este TARGET, nunca para a policy compartilhada inteira.
  app.patch('/api/bgp/mitigation/profiles/:id/exclusion', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return undefined;
    const { id } = profileParams.parse(request.params);
    const payload = exclusionSchema.parse(request.body ?? {});
    const updated = await service.setProfileExclusion(id, {
      excluded: payload.excluded,
      ...(payload.reason === undefined ? {} : { reason: payload.reason }),
      ...(payload.note === undefined ? {} : { note: payload.note ?? null }),
    });
    if (!updated) return reply.code(404).send({ message: 'Perfil de mitigacao nao encontrado' });
    return updated;
  });

  app.patch('/api/bgp/mitigation/profiles/:id', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return undefined;
    const { id } = profileParams.parse(request.params);
    const payload = patchSchema.parse(request.body ?? {});
    const updated = await service.patchProfile(id, {
      ...(payload.bandwidthOverrideBps === undefined
        ? {}
        : { bandwidthOverrideBps: payload.bandwidthOverrideBps }),
      ...(payload.enabled === undefined ? {} : { enabled: payload.enabled }),
      ...(payload.mode === undefined ? {} : { mode: payload.mode }),
    });
    if (!updated) return reply.code(404).send({ message: 'Perfil de mitigacao nao encontrado' });
    return updated;
  });
}
