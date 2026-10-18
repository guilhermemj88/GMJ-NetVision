/**
 * Fase E/G — contrato de estilo do WeatherMap bidirecional.
 *
 * Lê o `globals.css` de verdade e garante:
 *  1. os tokens de DIREÇÃO são fixos e derivam da identidade do NetVision;
 *  2. as plaquetas usam o token `--wm-pill` (utilização) e o runner a cor fixa
 *     da direção;
 *  3. o movimento é CSS puro e é desligado de verdade em `prefers-reduced-motion`;
 *  4. nenhuma regra nova toca as classes da V1 (`.traffic-edge`, `.map-statusbar`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  fileURLToPath(new URL('../app/globals.css', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

function ruleBody(selector: string): string | null {
  const index = css.indexOf(`\n${selector} {`);
  if (index === -1) return null;
  const start = css.indexOf('{', index);
  const end = css.indexOf('}', start);
  return css.slice(start + 1, end);
}

describe('tokens do WeatherMap', () => {
  it('deriva as cores de utilização da paleta existente', () => {
    expect(ruleBody(':root')).not.toBeNull();
    expect(css).toContain('--wm-util-normal: var(--green)');
    expect(css).toContain('--wm-util-attention: var(--amber)');
    expect(css).toContain('--wm-util-critical: var(--red)');
  });

  it('define as cores FIXAS de direção (A→B ciano, B→A violeta)', () => {
    expect(css).toContain('--wm-dir-a2b: var(--cyan-bright)');
    expect(css).toContain('--wm-dir-b2a: var(--violet)');
    // A identidade ganha o token de violeta no nível do tema.
    expect(css).toMatch(/--violet: #[\da-fA-F]{6};/);
  });

  it('define os estados sem tráfego com tons próprios', () => {
    expect(css).toContain('--wm-state-down: var(--red)');
    expect(css).toContain('--wm-state-no-data: #718894');
    expect(css).toContain('--wm-state-stale: #8a9fb0');
    expect(css).toContain('--wm-state-inconsistent: #a98bd6');
    expect(css).toContain('--wm-state-unknown: #4d6270');
  });

  it('a plaqueta é a única que consome a cor de utilização', () => {
    const pill = ruleBody('.traffic-edge-v2__label--pill') ?? '';
    expect(pill).toContain('var(--wm-pill');
    // Fundo opaco: a linha não atravessa os caracteres da plaqueta.
    expect(pill).toMatch(/background: rgba\(8, 14, 19, 0\.9\d\)/);
    // O token antigo de esmaecimento saiu junto com o desenho da Fase F.
    expect(css).not.toContain('--wm-dim-mix');
    expect(css).not.toContain('.traffic-edge-v2__label--normal');
  });
});

describe('Fase M — paleta operacional (estilo A/B do preview)', () => {
  it('define os três tons foscos e o texto branco suave', () => {
    expect(css).toContain('--wm-op-normal: #43866e');
    expect(css).toContain('--wm-op-attention: #c79a45');
    expect(css).toContain('--wm-op-critical: #c65c63');
    expect(css).toContain('--wm-op-text: #e1e8e5');
  });

  it('a borda da plaqueta operacional usa o MESMO token do traço/seta', () => {
    const rule =
      ruleBody(".traffic-edge-v2__label--pill[data-link-style='operational']") ?? '';
    expect(rule).toContain('var(--wm-pill');
    expect(rule).toContain('var(--wm-op-text)');
  });

  it('no modo operacional os ícones da legenda também seguem a paleta', () => {
    expect(css).toContain(
      ".map-v2-legend[data-link-style='operational'] .map-v2-legend__item i.is-solid",
    );
    expect(css).toContain(
      ".map-v2-legend[data-link-style='operational'] .map-v2-legend__item i.is-chevron",
    );
  });

  it('a V1 fica intocada: nenhum arquivo/regra dela conhece o estilo novo', () => {
    const v1Edge = readFileSync(
      fileURLToPath(new URL('./traffic-edge.tsx', import.meta.url)),
      'utf8',
    );
    expect(v1Edge).not.toContain('map-visual-v2-style');
    expect(v1Edge).not.toContain('--wm-op-');
    // Nenhuma regra da paleta operacional atinge classes da V1.
    const operationalRules = css.split('\n').filter((line) => line.includes('--wm-op-'));
    for (const line of operationalRules) {
      expect(line).not.toMatch(/\.traffic-edge\s*[,{]/);
      expect(line).not.toMatch(/\.map-statusbar/);
    }
  });
});

describe('microanimação', () => {
  it('os runners usam animação CSS contínua e invertida por sentido', () => {
    expect(ruleBody('.traffic-edge-v2__runner')).toContain('animation-iteration-count: infinite');
    expect(ruleBody('.traffic-edge-v2__runner')).toContain('offset-distance: 0%');
    const forward = /@keyframes wm-runner-forward \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(forward).toContain('offset-distance: 0%');
    expect(forward).toContain('offset-distance: 100%');
    const reverse = /@keyframes wm-runner-reverse \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(reverse).toContain('offset-distance: 100%');
    expect(reverse).toContain('offset-distance: 0%');
  });

  it('o chevron do B→A é vazado e o runner herda o tom da direção', () => {
    expect(css).toContain('.traffic-edge-v2__runner--b2a svg path');
    expect(css).toContain('stroke: var(--wm-runner-color');
    expect(css).toContain('.traffic-edge-v2__runner--a2b svg path');
    expect(css).toContain('fill: var(--wm-runner-color');
    // Fallback do runner: cor da direção, nunca cor de utilização.
    expect(ruleBody('.traffic-edge-v2__runner--a2b svg path')).toContain('var(--wm-dir-a2b)');
    expect(ruleBody('.traffic-edge-v2__runner--b2a svg path')).toContain('var(--wm-dir-b2a)');
  });

  it('prefers-reduced-motion desliga o movimento de verdade', () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(block).toContain('.traffic-edge-v2__runner');
    expect(block).toContain('animation: none');
  });

  it('o divisor central é vertical (→│←) e neutro', () => {
    const center = ruleBody('.traffic-edge-v2__center') ?? '';
    expect(center).toContain('stroke: var(--wm-center-bar)');
    expect(center).toContain('stroke-linecap: round');
  });
});

describe('isolamento da V1', () => {
  it('as classes novas não atingem as classes da V1', () => {
    const weatherRules = [...css.matchAll(/\n([^\n{}]*(?:traffic-edge-v2__|map-v2-legend)[^\n{}]*)\{/g)].map(
      (match) => (match[1] ?? '').trim(),
    );
    expect(weatherRules.length).toBeGreaterThan(8);
    for (const selector of weatherRules) {
      for (const part of selector.split(',')) {
        const trimmed = part.trim();
        // Nunca um seletor "solto" que pegue a V1 (ex.: `.traffic-edge--animated`).
        expect(trimmed.includes('traffic-edge-v2__') || trimmed.includes('map-v2-legend')).toBe(true);
      }
    }
  });

  it('a V1 continua com o traço, a animação e a barra de status anteriores', () => {
    expect(ruleBody('.traffic-edge--base')).toContain('stroke: #22333d');
    expect(ruleBody('.traffic-edge--flow')).toContain('stroke-linecap: round');
    expect(ruleBody('.map-statusbar')).toContain('position: absolute');
    // A legenda V2 é um elemento NOVO, acima da barra — o rodapé da V1 não muda.
    expect(ruleBody('.map-v2-legend')).toContain('bottom: 52px');
  });
});
