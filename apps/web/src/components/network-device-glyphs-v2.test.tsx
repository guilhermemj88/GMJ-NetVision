import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_GLYPH_V2_TYPES,
  NetworkDeviceGlyphV2,
  glyphStrokeWidth,
  resolveDeviceGlyphV2,
  type DeviceGlyphV2Type,
} from './network-device-glyphs-v2';

function render(type: DeviceGlyphV2Type, props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(NetworkDeviceGlyphV2, { type, size: 32, ...props }));
}

function dotCount(markup: string): number {
  return (markup.match(/h\.01/g) ?? []).length;
}

describe('resolveDeviceGlyphV2', () => {
  it('resolve os tipos legados com equivalência inequívoca', () => {
    const expected: ReadonlyArray<readonly [string, DeviceGlyphV2Type]> = [
      ['CORE_ROUTER', 'CORE_ROUTER'],
      ['EDGE_ROUTER', 'ROUTER'],
      ['ROUTER', 'ROUTER'],
      ['CORE_SWITCH', 'SWITCH'],
      ['SWITCH', 'SWITCH'],
      ['AGGREGATION', 'AGGREGATION'],
      ['OLT', 'OLT'],
      ['CLOUD', 'CLOUD'],
      ['IX', 'IX'],
      ['PNI', 'PNI'],
      ['CLUSTER', 'CLUSTER'],
      ['BNG', 'BNG'],
    ];
    for (const [legacyType, glyph] of expected) {
      expect(resolveDeviceGlyphV2(legacyType)).toBe(glyph);
    }
  });

  it('mantém CORE_SWITCH → SWITCH provisório, com o desenho novo disponível', () => {
    // O glifo CORE_SWITCH já existe, mas o mapeamento global continua SWITCH
    // até a aprovação no laboratório. Ativar a troca é uma decisão explícita.
    expect(DEVICE_GLYPH_V2_TYPES).toContain('CORE_SWITCH');
    expect(resolveDeviceGlyphV2('CORE_SWITCH')).toBe('SWITCH');
  });

  it('devolve null (fallback V1) para tipos ainda sem desenho V2', () => {
    const withoutV2 = [
      'AUTO',
      'ONU',
      'FIREWALL',
      'SERVER',
      'WIRELESS',
      'CUSTOMERS',
      'CARRIER',
      'TRANSPORT',
      'DATACENTER',
      'SERVICE',
      'PEER',
      'CUSTOM',
      'GENERIC',
      'NAO_EXISTE',
    ];
    for (const legacyType of withoutV2) {
      expect(resolveDeviceGlyphV2(legacyType)).toBeNull();
    }
  });
});

describe('glyphStrokeWidth', () => {
  it('engrossa o traço nos tamanhos pequenos', () => {
    expect(glyphStrokeWidth(16)).toBe(3);
    expect(glyphStrokeWidth(20)).toBe(3);
    expect(glyphStrokeWidth(24)).toBe(2.6);
    expect(glyphStrokeWidth(28)).toBe(2.6);
    expect(glyphStrokeWidth(32)).toBe(2.2);
    expect(glyphStrokeWidth(48)).toBe(2.2);
  });
});

describe('NetworkDeviceGlyphV2', () => {
  it('renderiza todos os tipos com o contrato do viewBox, sem fill e com data-glyph', () => {
    expect(DEVICE_GLYPH_V2_TYPES).toHaveLength(11);
    for (const type of DEVICE_GLYPH_V2_TYPES) {
      const markup = render(type);
      expect(markup).toContain('viewBox="0 0 64 64"');
      expect(markup).toContain('stroke="currentColor"');
      expect(markup).toContain('fill="none"');
      expect(markup).toContain('stroke-linecap="round"');
      expect(markup).toContain('stroke-linejoin="round"');
      expect(markup).toContain(`data-glyph="${type}"`);
      expect(markup).toMatch(/<(path|circle|rect)/);
    }
  });

  it('desenha cada tipo com markup único; CORE_SWITCH tem chassi duplo próprio', () => {
    const rendered = DEVICE_GLYPH_V2_TYPES.map((type) => render(type));
    expect(new Set(rendered).size).toBe(DEVICE_GLYPH_V2_TYPES.length);

    const coreSwitch = render('CORE_SWITCH');
    expect(coreSwitch).not.toBe(render('SWITCH'));
    expect(coreSwitch).toContain('M16 18V12H56V32');
  });

  it('renderiza 16/24/32/48 px em todos os tipos', () => {
    for (const size of [16, 24, 32, 48]) {
      for (const type of DEVICE_GLYPH_V2_TYPES) {
        const markup = render(type, { size });
        expect(markup).toContain(`width="${size}"`);
        expect(markup).toContain(`height="${size}"`);
      }
    }
  });

  it('usa glyphStrokeWidth(size) quando strokeWidth não é passado', () => {
    expect(render('CLOUD', { size: 16 })).toContain('stroke-width="3"');
    expect(render('CLOUD', { size: 32 })).toContain('stroke-width="2.2"');
  });

  it('respeita size e strokeWidth explícitos', () => {
    const markup = render('CLOUD', { size: 48, strokeWidth: 3 });
    expect(markup).toContain('width="48"');
    expect(markup).toContain('stroke-width="3"');
  });

  it('BNG compact é opt-in e reduz o desenho (tronco curto, um assinante)', () => {
    const normal = render('BNG');
    const compact = render('BNG', { compact: true });

    expect(compact).not.toBe(normal);
    expect(normal).toContain('M32 26V36M32 36L16 47M32 36V47M32 36L48 47');
    expect(compact).toContain('M32 26V40');
    expect(dotCount(normal)).toBeGreaterThan(dotCount(compact));
    expect(dotCount(compact)).toBeGreaterThan(0);
  });

  it('compact não altera desenhos que não o usam', () => {
    expect(render('SWITCH', { compact: true })).toBe(render('SWITCH'));
  });

  it('com title vira imagem acessível (role=img + aria-labelledby)', () => {
    const markup = render('OLT', { title: 'OLT do centro' });
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-labelledby="');
    expect(markup).toContain('<title');
    expect(markup).toContain('OLT do centro');
    expect(markup).not.toContain('aria-hidden');
  });

  it('sem title fica decorativo (aria-hidden, sem role)', () => {
    const markup = render('OLT');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="img"');
  });
});
