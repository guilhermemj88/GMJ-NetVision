// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorizontalScroll } from './horizontal-scroll';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
let scroll: HTMLDivElement;
const click = vi.fn();

function pointer(target: Element, type: string, x: number, extra = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: x,
    ...extra,
  });
  target.dispatchEvent(event);
}
beforeEach(async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <HorizontalScroll label="Test controls">
        <button onClick={click}>Action</button>
        <input />
        <select>
          <option>A</option>
        </select>
        <textarea />
        <a href="#test">Link</a>
        <div role="button">Role</div>
        <span>Selectable text</span>
      </HorizontalScroll>,
    ),
  );
  scroll = host.querySelector('.horizontal-scroll__viewport')!;
  Object.defineProperties(scroll, { scrollWidth: { value: 1000 }, clientWidth: { value: 300 } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe('horizontal scrolling', () => {
  it('drags blank space after a threshold and resets on cancel', () => {
    pointer(scroll, 'pointerdown', 200);
    pointer(scroll, 'pointermove', 197);
    expect(scroll.scrollLeft).toBe(0);
    pointer(scroll, 'pointermove', 120);
    expect(scroll.scrollLeft).toBe(80);
    expect(scroll.classList.contains('is-dragging')).toBe(true);
    pointer(scroll, 'pointercancel', 120);
    pointer(scroll, 'pointermove', 90);
    expect(scroll.scrollLeft).toBe(80);
    expect(scroll.classList.contains('is-dragging')).toBe(false);
  });
  it.each(['button', 'input', 'select', 'textarea', 'a', '[role="button"]', 'span'])(
    'preserves interaction and text selection on %s',
    (selector) => {
      const target = host.querySelector(selector)!;
      pointer(target, 'pointerdown', 200);
      pointer(target, 'pointermove', 80);
      expect(scroll.scrollLeft).toBe(0);
      expect(scroll.classList.contains('is-dragging')).toBe(false);
    },
  );
  it('preserves native touch, ordinary clicks, and keyboard scrolling', async () => {
    pointer(scroll, 'pointerdown', 200, { pointerType: 'touch' });
    pointer(scroll, 'pointermove', 80, { pointerType: 'touch' });
    expect(scroll.scrollLeft).toBe(0);
    await act(async () => host.querySelector('button')!.click());
    expect(click).toHaveBeenCalledOnce();
    scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(scroll.scrollLeft).toBe(1000);
    scroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(scroll.scrollLeft).toBe(0);
  });
  it('updates directional overflow hints at both edges', async () => {
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(host.firstElementChild?.getAttribute('data-right')).toBe('true');
    scroll.scrollLeft = 700;
    await act(async () => scroll.dispatchEvent(new Event('scroll')));
    expect(host.firstElementChild?.getAttribute('data-left')).toBe('true');
    expect(host.firstElementChild?.getAttribute('data-right')).toBe('false');
  });
});
