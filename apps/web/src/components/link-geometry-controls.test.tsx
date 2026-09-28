// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneDemoMaps, type NetworkLink } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateLink } from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { LinkGeometryControls } from './link-geometry-controls';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  updateLink: vi.fn(),
}));

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) =>
    (item.textContent ?? '').includes(label),
  );
  if (!button) throw new Error(`Botao ${label} nao encontrado`);
  return button;
}

describe('LinkGeometryControls', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const link: NetworkLink = {
    ...cloneDemoMaps()[0]!.links[0]!,
    label: 'CORE-BR-01 para AGG-CENTRO-01',
    linkLayoutMode: 'MANUAL' as const,
    visualPaths: [
      { order: 0, label: 'Principal', customColor: '#123456', curvature: 175, enabled: true },
    ],
  };

  beforeEach(async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    const map = cloneDemoMaps()[0]!;
    map.links = [structuredClone(link)];
    useMapStore.setState({
      map,
      activeMapId: map.id,
      selection: { kind: 'link', id: link.id },
      editMode: false,
      readOnly: false,
      linkGeometryDrafts: {},
      showToast: vi.fn(),
    });
    vi.mocked(updateLink).mockImplementation(async (_mapId, _linkId, input) => ({
      ...link,
      ...input,
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    useMapStore.setState({ map: null, selection: null, editMode: false, linkGeometryDrafts: {} });
  });

  async function render() {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <LinkGeometryControls />
        </QueryClientProvider>,
      ),
    );
  }

  it('sem enlace selecionado explica como editar e liga o modo edicao', async () => {
    useMapStore.setState({ selection: null });
    await render();

    expect(container.textContent).toContain('Selecione um enlace no mapa');
    await act(async () => {
      findButton(container, 'Ativar modo edição').click();
    });
    expect(useMapStore.getState().editMode).toBe(true);
    expect(updateLink).not.toHaveBeenCalled();
  });

  it('resetar geometria zera a curvatura sem trocar o modo manual', async () => {
    await render();

    expect(container.textContent).toContain('Geometria manual');
    await act(async () => {
      findButton(container, 'Resetar geometria').click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(updateLink).toHaveBeenCalledWith(
      link.mapId,
      link.id,
      expect.objectContaining({
        linkLayoutMode: 'MANUAL',
        visualPaths: [expect.objectContaining({ curvature: 0 })],
      }),
    );
    expect(useMapStore.getState().linkGeometryDrafts[link.id]).toBeUndefined();
  });

  it('voltar ao automatico devolve o enlace para AUTO com curvatura zero', async () => {
    await render();

    await act(async () => {
      findButton(container, 'Voltar ao automático').click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(updateLink).toHaveBeenCalledWith(
      link.mapId,
      link.id,
      expect.objectContaining({
        linkLayoutMode: 'AUTO',
        visualPaths: [expect.objectContaining({ curvature: 0 })],
      }),
    );
  });

  it('troca a ponta do enlace pelo handle persistindo a mesma geometria', async () => {
    await render();

    const source = container.querySelector<HTMLSelectElement>('select')!;
    await act(async () => {
      source.value = 'TOP';
      source.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(updateLink).toHaveBeenCalledWith(
      link.mapId,
      link.id,
      expect.objectContaining({ sourceHandleSide: 'TOP' }),
    );
  });

  it('nao renderiza nada em mapa somente leitura', async () => {
    useMapStore.setState({ readOnly: true });
    await render();

    expect(container.textContent).toBe('');
    expect(updateLink).not.toHaveBeenCalled();
  });
});
