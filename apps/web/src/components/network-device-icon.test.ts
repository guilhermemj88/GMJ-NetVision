import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEVICE_ICON_TYPES, type NetworkDeviceIconType } from '@/lib/device-appearance';
import { NetworkDeviceIcon } from './network-device-icon';

const iconTypes = DEVICE_ICON_TYPES.filter(
  (iconType): iconType is NetworkDeviceIconType => iconType !== 'AUTO',
);

function renderIcon(type: NetworkDeviceIconType): string {
  return renderToStaticMarkup(
    createElement(NetworkDeviceIcon, { type, variant: '2d', status: 'up', size: 32 }),
  );
}

describe('NetworkDeviceIcon', () => {
  it('renders every resolved icon type through the canonical union', () => {
    expect(iconTypes).toHaveLength(15);
    for (const iconType of iconTypes) {
      expect(renderIcon(iconType)).toContain(
        `${iconType.toLowerCase().replaceAll('_', ' ')} device icon`,
      );
    }
  });

  it('keeps core router, edge router and core switch glyphs distinct', () => {
    const coreRouter = renderIcon('CORE_ROUTER');
    const edgeRouter = renderIcon('EDGE_ROUTER');
    const coreSwitch = renderIcon('CORE_SWITCH');

    expect(coreRouter).not.toBe(edgeRouter);
    expect(coreRouter).not.toBe(coreSwitch);
    expect(edgeRouter).not.toBe(coreSwitch);
  });

  it('renders unique vector content for every icon type', () => {
    const rendered = new Set(iconTypes.map(renderIcon));
    expect(rendered.size).toBe(iconTypes.length);
  });

  it('renders drawing primitives for every icon type', () => {
    for (const iconType of iconTypes) {
      const markup = renderIcon(iconType);
      expect(markup).toMatch(/<(path|circle|rect)/);
    }
  });
});
