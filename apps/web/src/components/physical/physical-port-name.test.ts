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
});
