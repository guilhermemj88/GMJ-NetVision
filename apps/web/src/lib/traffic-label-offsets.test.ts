// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countTrafficLabelOffsets,
  getTrafficLabelOffsets,
  parseTrafficLabelOffsets,
  resetTrafficLabelOffsets,
  setTrafficLabelOffset,
  subscribeTrafficLabelOffsets,
  trafficLabelOffset,
  trafficLabelOffsetsKey,
} from './traffic-label-offsets';

describe('traffic label offsets', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('guarda o deslocamento por lane, sem tocar na direcao vizinha', () => {
    setTrafficLabelOffset('map-1', 'link-1', 'a', { dx: 12, dy: -8 });

    const offsets = getTrafficLabelOffsets('map-1');
    expect(trafficLabelOffset(offsets, 'link-1', 'a')).toEqual({ dx: 12, dy: -8 });
    expect(trafficLabelOffset(offsets, 'link-1', 'b')).toBeNull();
    expect(countTrafficLabelOffsets(offsets)).toBe(1);

    setTrafficLabelOffset('map-1', 'link-1', 'b', { dx: -4, dy: 2 });
    const both = getTrafficLabelOffsets('map-1');
    expect(trafficLabelOffset(both, 'link-1', 'a')).toEqual({ dx: 12, dy: -8 });
    expect(trafficLabelOffset(both, 'link-1', 'b')).toEqual({ dx: -4, dy: 2 });
    expect(countTrafficLabelOffsets(both)).toBe(2);
  });

  it('isola mapas e enlaces diferentes', () => {
    setTrafficLabelOffset('map-1', 'link-1', 'a', { dx: 10, dy: 10 });
    setTrafficLabelOffset('map-2', 'link-1', 'a', { dx: -20, dy: 0 });
    setTrafficLabelOffset('map-1', 'link-2', 'a', { dx: 0, dy: 30 });

    expect(countTrafficLabelOffsets(getTrafficLabelOffsets('map-1'))).toBe(2);
    expect(trafficLabelOffset(getTrafficLabelOffsets('map-2'), 'link-1', 'a')).toEqual({
      dx: -20,
      dy: 0,
    });
    expect(countTrafficLabelOffsets(getTrafficLabelOffsets('map-3'))).toBe(0);
  });

  it('reset individual devolve so aquela lane', () => {
    setTrafficLabelOffset('map-1', 'link-1', 'a', { dx: 5, dy: 5 });
    setTrafficLabelOffset('map-1', 'link-1', 'b', { dx: 6, dy: 6 });
    setTrafficLabelOffset('map-1', 'link-1', 'a', null);

    const offsets = getTrafficLabelOffsets('map-1');
    expect(trafficLabelOffset(offsets, 'link-1', 'a')).toBeNull();
    expect(trafficLabelOffset(offsets, 'link-1', 'b')).toEqual({ dx: 6, dy: 6 });
  });

  it('reset global limpa o mapa inteiro e remove a chave do storage', () => {
    setTrafficLabelOffset('map-1', 'link-1', 'a', { dx: 5, dy: 5 });
    setTrafficLabelOffset('map-1', 'link-2', 'b', { dx: 7, dy: 7 });
    expect(window.localStorage.getItem(trafficLabelOffsetsKey('map-1'))).not.toBeNull();

    resetTrafficLabelOffsets('map-1');

    expect(countTrafficLabelOffsets(getTrafficLabelOffsets('map-1'))).toBe(0);
    expect(window.localStorage.getItem(trafficLabelOffsetsKey('map-1'))).toBeNull();
  });

  it('notifica assinantes e aceita storage externo', () => {
    const onStoreChange = vi.fn();
    const unsubscribe = subscribeTrafficLabelOffsets(onStoreChange);

    setTrafficLabelOffset('map-1', 'link-1', 'a', { dx: 1, dy: 1 });
    expect(onStoreChange).toHaveBeenCalled();

    onStoreChange.mockClear();
    window.dispatchEvent(
      new StorageEvent('storage', { key: trafficLabelOffsetsKey('map-2') }),
    );
    expect(onStoreChange).toHaveBeenCalled();

    unsubscribe();
  });

  it('descarta lixo, valores enormes e offset zero', () => {
    expect(parseTrafficLabelOffsets('nao-e-json')).toEqual({});
    expect(parseTrafficLabelOffsets('[]')).toEqual({});
    expect(
      parseTrafficLabelOffsets(
        JSON.stringify({ 'link-1': { a: { dx: 'x', dy: 2 }, b: { dx: 0, dy: 0 } } }),
      ),
    ).toEqual({});

    const clamped = parseTrafficLabelOffsets(
      JSON.stringify({ 'link-1': { a: { dx: 99999, dy: -99999 } } }),
    );
    expect(clamped['link-1']?.a).toEqual({ dx: 4000, dy: -4000 });
  });
});
