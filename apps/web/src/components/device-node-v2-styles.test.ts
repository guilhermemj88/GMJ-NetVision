/**
 * Contrato de estilo do nó V2 (Fase D — correção visual).
 *
 * O ajuste "sem orb" é CSS: por isso o teste lê o `globals.css` de verdade e
 * garante quatro coisas que não podem regredir:
 *  1. o orb da V1 continua existindo (nada foi removido da produção);
 *  2. o V2 zera borda circular, gradiente, brilho e o anel de `::before`;
 *  3. TODA regra nova da V2 está sob o prefixo `.device-node.device-node--v2`;
 *  4. o prefixo duplicado é obrigatório: existem regras da V1 com 2 classes
 *     declaradas DEPOIS do bloco V2 (ex.: `.device-node--icon_3d .device-node__icon`),
 *     e só a especificidade maior impede o círculo de voltar no modo ICON_3D.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

/** Bloco de regras de um seletor (texto entre `{` e o `}` correspondente). */
function ruleBody(selector: string): string | null {
  const index = css.indexOf(`\n${selector} {`);
  if (index === -1) return null;
  const start = css.indexOf('{', index);
  const end = css.indexOf('}', start);
  return css.slice(start + 1, end);
}

describe('V1 continua com o orb (nada foi removido da produção)', () => {
  it('mantém círculo, gradiente e brilho no .device-node__icon', () => {
    const body = ruleBody('.device-node__icon');
    expect(body).not.toBeNull();
    expect(body).toContain('border-radius: 50%');
    expect(body).toContain('radial-gradient');
    expect(body).toContain('box-shadow');
  });

  it('mantém o anel externo do ::before e a caixa dos nós', () => {
    expect(ruleBody('.device-node__icon::before')).toContain('border-radius: 50%');
    expect(css).toContain('.device-node--icon_2d,\n.device-node--icon_3d {');
    expect(css).toContain('--orb-size: 46px');
  });
});

describe('V2 sem orb', () => {
  it('zera borda circular, fundo, sombra e filtro do ícone', () => {
    const body = ruleBody('.device-node.device-node--v2 .device-node__icon');
    expect(body).not.toBeNull();
    expect(body).toContain('border: 0');
    expect(body).toContain('border-radius: 0');
    expect(body).toContain('background: none');
    expect(body).toContain('box-shadow: none');
  });

  it('remove o anel externo (::before) e os brilhos do glifo', () => {
    expect(ruleBody('.device-node.device-node--v2 .device-node__icon::before')).toContain(
      'content: none',
    );
    const glow = ruleBody(
      [
        '.device-node.device-node--v2 .device-node__glyph,',
        '.device-node.device-node--v2 .device-node__svg,',
        '.device-node.device-node--v2 .device-node__svg--3d',
      ].join('\n'),
    );
    expect(glow).toContain('filter: none');
  });

  it('mantém status, tipo, nome e seleção como elementos separados', () => {
    expect(ruleBody('.device-node.device-node--v2 .status-pulse')).toContain('box-shadow: none');
    expect(ruleBody('.device-node.device-node--v2 .device-node__type')).not.toBeNull();
    expect(ruleBody('.device-node.device-node--v2.is-selected::before')).toContain(
      'border-radius: 10px',
    );
  });

  it('não altera as variáveis de posicionamento usadas pelos handles', () => {
    // Nenhuma regra da V2 redefine --orb-size/--orb-top: a métrica do nó é a mesma.
    const v2Blocks = [...css.matchAll(/\.device-node--v2[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(v2Blocks.length).toBeGreaterThan(4);
    for (const block of v2Blocks) {
      expect(block).not.toMatch(/--orb-size\s*:/);
      expect(block).not.toMatch(/--orb-top\s*:/);
    }
  });

  it('todas as regras novas da V2 são escopadas em .device-node.device-node--v2', () => {
    const selectors = [...css.matchAll(/(^|\n)([^\n{}]*\.device-node--v2[^\n{}]*)\{/g)]
      .map((match) => (match[2] ?? '').trim())
      .filter(Boolean);
    expect(selectors.length).toBeGreaterThan(4);
    for (const selector of selectors) {
      for (const part of selector.split(',')) {
        expect(part.trim().startsWith('.device-node.device-node--v2')).toBe(true);
      }
    }
  });

  it('vence as regras da V1 com 2 classes declaradas depois do bloco V2', () => {
    // Especificidade: `.device-node.device-node--v2 .device-node__icon` = 0,3,0
    // contra `.device-node--icon_3d .device-node__icon` = 0,2,0 (linha ~1986).
    const v2RuleIndex = css.indexOf('.device-node.device-node--v2 .device-node__icon {');
    const v1Icon3dIndex = css.indexOf('.device-node--icon_3d .device-node__icon {');
    expect(v2RuleIndex).toBeGreaterThan(-1);
    expect(v1Icon3dIndex).toBeGreaterThan(v2RuleIndex);
    expect(ruleBody('.device-node--icon_3d .device-node__icon')).toContain('box-shadow');
  });

  it('não interfere na caixa do nó (handles e enlaces ficam onde estavam)', () => {
    // A única regra da V2 que mira o próprio nó muda só o cursor: largura,
    // altura, zoom e as variáveis do orb continuam vindo da V1.
    const nodeRule = ruleBody('.device-node.device-node--v2');
    expect(nodeRule).not.toBeNull();
    expect(nodeRule).not.toMatch(/(^|;)\s*(width|height|zoom|transform|left|top)\s*:/);
    expect(nodeRule).toContain('cursor');
  });
});
