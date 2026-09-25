/* @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_BANNER_TEXT, PreviewBanner } from './preview-banner';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('PreviewBanner', () => {
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
    vi.unstubAllEnvs();
  });

  function render(): HTMLElement | null {
    act(() => {
      root.render(createElement(PreviewBanner));
    });
    return container.querySelector('[data-testid="preview-banner"]');
  }

  it('mostra o identificador quando NEXT_PUBLIC_PREVIEW_MODE=true', () => {
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', 'true');

    const banner = render();

    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain(PREVIEW_BANNER_TEXT);
    expect(banner?.textContent).toContain('DADOS DE PRODUÇÃO');
  });

  it('não renderiza nada quando NEXT_PUBLIC_PREVIEW_MODE=false', () => {
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', 'false');

    expect(render()).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('não renderiza nada quando a flag está ausente', () => {
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');

    expect(render()).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('só liga com o valor exato "true"', () => {
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '1');

    expect(render()).toBeNull();
  });
});
