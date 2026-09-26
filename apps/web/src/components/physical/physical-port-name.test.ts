import { describe, expect, it } from 'vitest';
import {
  lastOrdinal,
  physicalPortCompactLabel,
  physicalPortDisplayName,
  physicalPortInterfaceName,
  physicalPortInterfacePrefix,
  physicalPortNameView,
  physicalPortPanelLabel,
} from './physical-port-name';

/**
 * Regra de produto: a identidade apresentada da porta é o **nome da interface
 * CLI**; o conector (`QSFP28`, `SFP28`…) é característica física e o rótulo do
 * painel continua disponível para correlação/inspector.
 */
describe('nome apresentado da porta física', () => {
  it('mappedInterface.name tem prioridade sobre catálogo e nome persistido', () => {
    const source = {
      portName: 'QSFP28-1',
      catalogInterfaceName: '100GE1/0/1',
      mappedInterfaceName: '100GE1/0/7',
    };
    expect(physicalPortInterfaceName(source)).toBe('100GE1/0/7');
    expect(physicalPortDisplayName(source)).toBe('100GE1/0/7');
    // o rótulo físico continua rastreável
    expect(physicalPortPanelLabel(source)).toBe('QSFP28-1');
  });

  it('catalogPort.interfaceName é usado antes de port.name', () => {
    const source = { portName: 'SFP28-12', catalogInterfaceName: '25GE1/0/12' };
    expect(physicalPortDisplayName(source)).toBe('25GE1/0/12');
    expect(physicalPortPanelLabel(source)).toBe('SFP28-12');
    expect(physicalPortCompactLabel(source)).toBe('12');
  });

  it('port.name continua sendo o fallback quando não há interface', () => {
    const source = { portName: 'SFP+-13', portLabel: 'SFP+-13' };
    expect(physicalPortInterfaceName(source)).toBeNull();
    expect(physicalPortDisplayName(source)).toBe('SFP+-13');
    // sem interface o rótulo físico é o próprio nome: não é repetido
    expect(physicalPortPanelLabel(source)).toBeNull();
    expect(physicalPortInterfacePrefix(source)).toBeNull();
    expect(physicalPortCompactLabel(source)).toBe('13');
  });

  it('extrai ordinal e prefixo hierárquico do nome apresentado', () => {
    expect(lastOrdinal('XGigabitEthernet0/0/48')).toBe('48');
    expect(lastOrdinal('100GE1/0/4')).toBe('4');
    expect(lastOrdinal('ether10')).toBe('10');
    expect(lastOrdinal('CONSOLE')).toBeNull();
    expect(physicalPortInterfacePrefix({ portName: 'x', mappedInterfaceName: '100GE1/0/4' })).toBe(
      '100GE1/0/',
    );
    expect(
      physicalPortInterfacePrefix({ portName: 'ether7', catalogInterfaceName: 'ether7' }),
    ).toBe('ether');
    // sem nome de interface não existe prefixo de CLI para legenda
    expect(physicalPortInterfacePrefix({ portName: 'ether7' })).toBeNull();
  });

  it('o rótulo curto vem da interface, nunca do cage', () => {
    // `QSFP28-1` é conector; o ordinal dentro do desenho é o da interface
    expect(physicalPortCompactLabel({ portName: 'QSFP28-1' })).toBe('1');
    expect(
      physicalPortCompactLabel({ portName: 'QSFP28-1', mappedInterfaceName: '100GE1/0/9' }),
    ).toBe('9');
  });

  it('physicalPortNameView monta a visão usada no desenho e no inspector', () => {
    const view = physicalPortNameView(
      { name: 'QSFP28-3', label: '', mappedInterface: null },
      { label: 'QSFP28-3', interfaceName: '100GE1/0/3' },
    );
    expect(view).toEqual({
      displayName: '100GE1/0/3',
      interfaceName: '100GE1/0/3',
      panelLabel: 'QSFP28-3',
      compactLabel: '3',
      interfacePrefix: '100GE1/0/',
    });
  });

  it('equipamento genérico sem catálogo usa mappedInterface.name após o sync', () => {
    const view = physicalPortNameView(
      {
        name: 'port1',
        label: '',
        mappedInterface: {
          id: 'if-1',
          deviceId: 'device-1',
          name: 'ether1',
          ifIndex: 1,
          alias: null,
          operStatus: 'UP',
        },
      },
      null,
    );
    expect(view.displayName).toBe('ether1');
    // a identidade persistida (`port1`) continua rastreável como porta física
    expect(view.panelLabel).toBe('port1');
  });

  /**
   * Regressão dos SKUs reais do POP: a MESMA regra (`mappedInterface.name`)
   * vale para o S6750-H36C, para o F1A e para o S6730 — sem exceção por
   * hostname de equipamento.
   */
  it('S6750-H36C, F1A e S6730 apresentam o nome CLI da interface', () => {
    const mapped = (name: string, ifIndex: number) => ({
      id: `if-${ifIndex}`,
      deviceId: `device-${ifIndex}`,
      name,
      ifIndex,
      alias: null,
      operStatus: 'UP' as const,
    });

    const s6750 = physicalPortNameView(
      { name: 'QSFP28-5', label: 'QSFP28-5', mappedInterface: mapped('100GE1/0/5', 5) },
      { label: 'QSFP28-5', interfaceName: '100GE1/0/5', panelNumber: 4 },
    );
    expect(s6750.displayName).toBe('100GE1/0/5');
    expect(s6750.panelLabel).toBe('QSFP28-5');
    expect(s6750.interfacePrefix).toBe('100GE1/0/');

    expect(
      physicalPortNameView({ name: '100GE-49', label: '', mappedInterface: mapped('100GE0/1/49', 49) })
        .displayName,
    ).toBe('100GE0/1/49');
    expect(
      physicalPortNameView({ name: 'QSFP28-6', label: '', mappedInterface: mapped('100GE0/0/6', 6) })
        .displayName,
    ).toBe('100GE0/0/6');
  });
});
