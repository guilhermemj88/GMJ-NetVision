/**
 * Fase E — contrato de estilo do WeatherMap bidirecional.
 *
 * Lê o `globals.css` de verdade e garante:
 *  1. os tokens `--wm-*` derivam da paleta do NetVision (mesma cor no traço,
 *     na seta, no rótulo e na legenda);
 *  2. o stream animado existe nos dois sentidos e é desligado de verdade em
 *     `prefers-reduced-motion`;
 *  3. nenhuma regra nova toca as classes da V1 (`.traffic-edge`, `.map-statusbar`).
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

  it('define os estados sem tráfego com tons próprios', () => {
    expect(css).toContain('--wm-state-down: var(--red)');
    expect(css).toContain('--wm-state-no-data: #718894');
    expect(css).toContain('--wm-state-stale: #8a9fb0');
    expect(css).toContain('--wm-state-inconsistent: #a98bd6');
    expect(css).toContain('--wm-state-unknown: #4d6270');
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

  it('o chevron do B→A é vazado e o runner herdа o tom do sentido', () => {
    expect(css).toContain('.traffic-edge-v2__runner--b2a svg path');
    expect(css).toContain('stroke: var(--wm-runner-color');
    expect(css).toContain('.traffic-edge-v2__runner--a2b svg path');
    expect(css).toContain('fill: var(--wm-runner-color');
  });

  it('prefers-reduced-motion desliga o stream de verdade', () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(block).toContain('.traffic-edge-v2__runner');
    expect(block).toContain('animation: none');
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
