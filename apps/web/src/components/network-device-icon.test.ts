import { describe, expect, it } from 'vitest';
import { resolveNetworkDeviceIconAsset } from './network-device-icon';

describe('resolveNetworkDeviceIconAsset', () => {
  it('maps router and cloud types to the expected asset paths', () => {
    expect(resolveNetworkDeviceIconAsset('router', '2d')).toBe('/network-icons/router-2d.svg');
    expect(resolveNetworkDeviceIconAsset('switch', '2d')).toBe('/network-icons/switch-2d.svg');
    expect(resolveNetworkDeviceIconAsset('cloud', '3d')).toBe('/network-icons/cloud-3d.svg');
    expect(resolveNetworkDeviceIconAsset('firewall', '3d')).toBe('/network-icons/firewall-3d.svg');
  });

  it('falls back to the generic asset when the type is unknown', () => {
    expect(resolveNetworkDeviceIconAsset('unknown', '2d')).toBe('/network-icons/generic-2d.svg');
  });
});

