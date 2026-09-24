/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicalVisualToggle } from './physical-visual-toggle';
import type { PhysicalVisualMode } from './physical-types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

  function labels(): string[] {
    return [...container.querySelectorAll('.physical-visual__options button')].map(
      (candidate) => candidate.textContent?.trim() ?? '',
    );
  }

  it('mostra Técnica antes de Real (visão técnica é a principal)', () => {
    render('TECHNICAL');
    expect(labels()).toEqual(['Técnica', 'Real']);
  });

  it('marca o modo atual e alterna entre Técnica e Real', () => {
    const { onChange } = render('TECHNICAL');
    expect(button('Técnica').getAttribute('aria-pressed')).toBe('true');
    expect(button('Real').getAttribute('aria-pressed')).toBe('false');

    act(() => {
      button('Real').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('REAL');
  });

  it('volta para o modo técnico a partir do modo real', () => {
    const { onChange } = render('REAL');
    expect(button('Real').getAttribute('aria-pressed')).toBe('true');
    expect(button('Técnica').getAttribute('aria-pressed')).toBe('false');
    act(() => {
      button('Técnica').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('TECHNICAL');
  });
});
