import { describe, expect, it } from 'vitest';
import { modularChassisMap } from './modular-chassis-map';
import { slotLabModuleKeys } from './slot-lab';
import {
  SLOT_LAB_CATEGORY_LABELS,
  SLOT_LAB_CHASSIS,
  SLOT_LAB_MODULES,
  buildSlotLabAsset,
  buildSlotLabCatalog,
  clearModules,
  removeModule,
  slotLabFit,
  slotLabModule,
  slotLabModuleCategory,
  slotLabPalette,
  slotLabSlotInfo,
  slotLabSlots,
  slotLabUnsupported,
  tryInstallModule,
} from './slot-lab';

/**
 * Slot Lab: bancada de encaixe. Insere/remove módulos do catálogo nos slots do
 * mapa e recusa incompatibilidade — nada é persistido e nada é inventado.
 */

describe('slot lab (bancada de encaixe)', () => {
  it('lista os chassis da bancada (OLTs + roteadores do catálogo)', () => {
    expect(SLOT_LAB_CHASSIS.map((chassis) => chassis.catalogKey)).toEqual([
      'huawei-ne8000-m4',
      'huawei-ne8000-m8-dc',
      'huawei-ne8000-m8-ac',
      'huawei-ma5800-x2',
      'huawei-ma5800-x7',
      'huawei-ma5800-x15',
      'huawei-ma5800-x17',
    ]);
  });

  it('os slots vêm do mapa, com papel e orientação derivada do bbox', () => {
    const x7 = slotLabSlots('huawei-ma5800-x7');
    expect(x7).toHaveLength(modularChassisMap('huawei-ma5800-x7')!.slots.length);
    expect(x7.every((slot) => slot.orientation === 'HORIZONTAL')).toBe(true);
    expect(x7.some((slot) => slot.role === 'SERVICE_OR_UPLINK')).toBe(true);

    const x15 = slotLabSlots('huawei-ma5800-x15');
    expect(x15.every((slot) => slot.orientation === 'VERTICAL')).toBe(true);
    expect(x15.length).toBeGreaterThanOrEqual(14);
  });

  it('moduleKeys do slot espelham o catálogo e limitam a instalação', () => {
    expect(slotLabModuleKeys('huawei-ma5800-x7', 1)).toEqual([
      'huawei-gpfd-16',
      'huawei-xgspon-16',
      'huawei-h902mpla',
    ]);

    const incompatible = tryInstallModule({}, 'huawei-ma5800-x7', 1, 'huawei-h901mpsc');
    expect(incompatible.ok).toBe(false);
    expect(incompatible.reason).toContain('Incompatível');
    expect(incompatible.state).toEqual({});

    const compatible = tryInstallModule({}, 'huawei-ma5800-x7', 1, 'huawei-gpfd-16');
    expect(compatible.ok).toBe(true);
    expect(compatible.reason).toContain('instalado');
    expect(compatible.state).toEqual({ 1: 'huawei-gpfd-16' });
  });

  it('recusa slot inexistente e módulo desconhecido', () => {
    expect(tryInstallModule({}, 'huawei-ma5800-x7', 99, 'huawei-gpfd-16').reason).toContain(
      'não existe',
    );
    expect(tryInstallModule({}, 'huawei-ma5800-x7', 1, 'modulo-fantasma').reason).toContain(
      'desconhecido',
    );
  });

  it('remove módulo de um slot e esvazia o chassi', () => {
    const installed = tryInstallModule({}, 'huawei-ma5800-x2', 1, 'huawei-gpfd-16').state;
    expect(removeModule(installed, 1)).toEqual({});
    expect(removeModule(installed, 2)).toEqual(installed);
    expect(clearModules()).toEqual({});
  });

  it('o equipamento da bancada só tem módulo onde foi instalado', () => {
    const installed = tryInstallModule({}, 'huawei-ma5800-x7', 2, 'huawei-xgspon-16').state;
    const asset = buildSlotLabAsset('huawei-ma5800-x7', installed);

    expect(asset.modules).toHaveLength(1);
    expect(asset.modules[0]!.moduleTemplateId).toBe('huawei-xgspon-16');
    expect(asset.slots.filter((slot) => slot.module !== null).map((slot) => slot.index)).toEqual([2]);
    // portas declaradas do XGS-PON: 16, nunca inventadas
    expect(asset.ports.map((port) => port.name)).toEqual(
      Array.from({ length: 16 }, (_value, index) => `XGSPON-${index + 1}`),
    );
  });

  it('a entrada de catálogo da bancada declara slots e módulos reais', () => {
    const installed = tryInstallModule({}, 'huawei-ma5800-x2', 1, 'huawei-gpfd-16').state;
    const entry = buildSlotLabCatalog('huawei-ma5800-x2', installed);

    expect(entry.catalogKey).toBe('huawei-ma5800-x2');
    expect(entry.slots.map((slot) => slot.moduleKeys)).toEqual(
      slotLabSlots('huawei-ma5800-x2').map((slot) => slotLabModuleKeys('huawei-ma5800-x2', slot.ordinal)),
    );
    // o módulo instalado resolve o painel: chave e part number declarados
    const gpfd = entry.modules.find((module) => module.key === 'huawei-gpfd-16')!;
    expect(gpfd.partNumber).toBe('H802GPFD');
    expect(gpfd.ports).toHaveLength(16);
    expect(gpfd.ports[0]!.portFunction).toBe('PON');
  });

  it('módulos da bancada têm part number declarado (sem nome fictício)', () => {
    for (const module of SLOT_LAB_MODULES) {
      expect(slotLabModule(module.key)).not.toBeNull();
      expect(module.partNumber).not.toBe('');
    }
    // a fonte não tem porta de serviço: só presença
    expect(slotLabModule('huawei-pac600s12-cb')!.ports).toHaveLength(0);
  });

  it('a paleta agrupa por categoria e marca o que o chassi aceita', () => {
    const palette = slotLabPalette('huawei-ma5800-x7');
    const byCategory = new Map(palette.map((group) => [group.category, group.items]));

    expect([...byCategory.keys()]).toEqual(['service', 'uplink']);
    expect(byCategory.get('service')!.map((item) => item.partNumber)).toEqual([
      'H802GPFD',
      'H803XGS',
    ]);
    expect(byCategory.get('uplink')!.map((item) => item.partNumber)).toEqual(['H902MPLA']);
    // todo item da paleta encaixa em pelo menos um slot declarado
    for (const group of palette) {
      for (const item of group.items) {
        expect(item.supported).toBe(true);
        expect(item.slotOrdinals.length).toBeGreaterThan(0);
        for (const ordinal of item.slotOrdinals) {
          expect(slotLabModuleKeys('huawei-ma5800-x7', ordinal)).toContain(item.moduleKey);
        }
      }
    }
  });

  it('chassi sem módulo declarado não lista nada na paleta (só não suportados)', () => {
    expect(slotLabPalette('huawei-ne8000-m8-dc')).toEqual([]);
    const unsupported = slotLabUnsupported('huawei-ne8000-m8-dc');
    expect(unsupported.map((item) => item.moduleKey)).toEqual(
      SLOT_LAB_MODULES.map((module) => module.key),
    );
    expect(unsupported.every((item) => !item.supported)).toBe(true);
    // no X7 a fonte também não é aceita em nenhum slot
    expect(slotLabUnsupported('huawei-ma5800-x7').map((item) => item.moduleKey)).toEqual([
      'huawei-h901mpsc',
      'huawei-pac600s12-cb',
    ]);
  });

  it('categoria visual do módulo segue a taxonomia do catálogo', () => {
    expect(slotLabModuleCategory('huawei-gpfd-16')).toBe('service');
    expect(slotLabModuleCategory('huawei-xgspon-16')).toBe('service');
    expect(slotLabModuleCategory('huawei-h902mpla')).toBe('uplink');
    expect(slotLabModuleCategory('huawei-h901mpsc')).toBe('control');
    expect(slotLabModuleCategory('huawei-pac600s12-cb')).toBe('power');
    expect(SLOT_LAB_CATEGORY_LABELS.service).toContain('Serviço');
  });

  it('realce de encaixe só existe com módulo armado e diz o motivo da recusa', () => {
    expect(slotLabFit('huawei-ma5800-x7', 1, null)).toBeNull();
    expect(slotLabFit('huawei-ma5800-x7', 1, 'huawei-gpfd-16')).toEqual({ tone: 'ok' });

    const bad = slotLabFit('huawei-ma5800-x7', 1, 'huawei-pac600s12-cb');
    expect(bad?.tone).toBe('bad');
    expect(bad?.reason).toContain('aceita');
    expect(slotLabFit('huawei-ne8000-m8-dc', 1, 'huawei-gpfd-16')?.reason).toContain(
      'sem moduleKeys declarados',
    );
  });

  it('inspector do slot mostra papel, moduleKeys e ocupante', () => {
    const empty = slotLabSlotInfo('huawei-ma5800-x7', 1, {});
    expect(empty).toMatchObject({
      ordinal: 1,
      role: 'SERVICE_OR_UPLINK',
      orientation: 'HORIZONTAL',
      installedModuleKey: null,
    });
    expect(empty!.moduleKeys).toEqual([
      'huawei-gpfd-16',
      'huawei-xgspon-16',
      'huawei-h902mpla',
    ]);

    const installed = slotLabSlotInfo('huawei-ma5800-x7', 1, { 1: 'huawei-xgspon-16' });
    expect(installed?.installedModuleKey).toBe('huawei-xgspon-16');
    expect(installed?.installedName).toContain('XGS-PON');

    const vertical = slotLabSlotInfo('huawei-ma5800-x15', 1, {});
    expect(vertical?.orientation).toBe('VERTICAL');
    expect(slotLabSlotInfo('huawei-ma5800-x7', 99, {})).toBeNull();
  });
});
