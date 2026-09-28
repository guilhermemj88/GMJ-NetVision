/* @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FreshnessTag } from './freshness-tag';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('FreshnessTag', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function render(at?: string | null) {
    act(() => {
      root.render(<FreshnessTag at={at} label="Mapa" />);
    });
    return container.querySelector('.freshness');
  }

  it('mostra o tempo relativo real do último carimbo', () => {
    const tag = render('2026-09-25T11:59:30.000Z');

    expect(tag?.textContent).toBe('Mapa há 30s');
    expect(tag?.className).not.toContain('is-stale');
  });

  it('avisa quando o dado envelhece', () => {
    const tag = render('2026-09-25T11:50:00.000Z');

    expect(tag?.className).toContain('is-stale');
    expect(tag?.textContent).toContain('pode estar desatualizado');
  });

  it('sem carimbo confiável não afirma que está atualizado', () => {
    const tag = render(null);

    expect(tag?.className).toContain('freshness--unknown');
    expect(tag?.textContent).toBe('Mapa: sem carimbo de coleta');
  });
});
