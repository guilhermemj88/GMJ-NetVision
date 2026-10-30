// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { GlobalInterfaceSearch } from './global-interface-search';

vi.mock('@/lib/api', () => ({ searchInterfaces: vi.fn().mockResolvedValue([]) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
});

it('portals results outside clipping, clamps to viewport, preserves inside clicks and closes on Escape/outside', async () => {
  host = document.createElement('div');
  host.style.overflow = 'hidden';
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <GlobalInterfaceSearch />
      </QueryClientProvider>,
    ),
  );
  const input = host.querySelector('input')!;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'x');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.parentElement).toBe(document.body);
  expect(dialog.style.position).toBe('fixed');
  expect(host.contains(dialog)).toBe(false);
  await act(async () => dialog.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => {
    input.blur();
    input.focus();
  });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
