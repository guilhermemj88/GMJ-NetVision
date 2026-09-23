/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicalVisualToggle } from './physical-visual-toggle';
import type { PhysicalVisualMode } from './physical-types';

describe('PhysicalVisualToggle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(mode: PhysicalVisualMode) {
    const onChange = vi.fn();
    act(() => {
      root.render(createElement(PhysicalVisualToggle, { mode, onChange }));
    });
    return { onChange };
  }

  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!found) throw new Error(`botão ${label} não encontrado`);
    return found as HTMLButtonElement;
  }

  it('marca o modo atual e alterna entre Real e Técnica', () => {
    const { onChange } = render('REAL');
    expect(button('Real').getAttribute('aria-pressed')).toBe('true');
    expect(button('Técnica').getAttribute('aria-pressed')).toBe('false');

    act(() => {
      button('Técnica').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('TECHNICAL');
  });

  it('volta para o modo real a partir do modo técnico', () => {
    const { onChange } = render('TECHNICAL');
    expect(button('Técnica').getAttribute('aria-pressed')).toBe('true');
    act(() => {
      button('Real').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('REAL');
  });
});
