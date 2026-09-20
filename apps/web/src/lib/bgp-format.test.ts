import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatBgpTraffic,
  formatBgpUptime,
  formatDurationShort,
  formatRelative,
  formatRouteCount,
} from './bgp-format';

describe('formatRouteCount', () => {
  it('renders null as a dash, never as zero', () => {
    expect(formatRouteCount(null)).toBe('-');
  });

  it('formats route counts with pt-BR grouping', () => {
    expect(formatRouteCount(1_099_912)).toBe('1.099.912');
  });
});

describe('formatBgpUptime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a dash when not established', () => {
    expect(formatBgpUptime(null)).toBe('-');
  });

  it('formats days and hours', () => {
    expect(formatBgpUptime('2026-09-01T00:00:00.000Z')).toBe('18d 12h');
  });

  it('formats hours and minutes', () => {
    expect(formatBgpUptime('2026-09-19T08:38:00.000Z')).toBe('3h 22m');
  });

  it('formats minutes only', () => {
    expect(formatBgpUptime('2026-09-19T11:18:00.000Z')).toBe('42m');
  });
});

describe('formatBgpTraffic', () => {
  it('renders null as a dash', () => {
    expect(formatBgpTraffic(null)).toBe('-');
  });

  it('formats G/M/K throughput compactly', () => {
    expect(formatBgpTraffic(4_800_000_000)).toBe('4.8G');
    expect(formatBgpTraffic(800_000_000)).toBe('800M');
    expect(formatBgpTraffic(650_000)).toBe('650K');
  });
});

describe('formatDurationShort', () => {
  it('renders null as a dash', () => {
    expect(formatDurationShort(null)).toBe('-');
  });

  it('formats seconds, minutes and hours compactly', () => {
    expect(formatDurationShort(252)).toBe('4m12s');
    expect(formatDurationShort(3900)).toBe('1h05m');
    expect(formatDurationShort(42)).toBe('42s');
  });
});

describe('formatRelative', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatRelative(42_000)).toBe('há 42s');
    expect(formatRelative(3 * 60_000)).toBe('há 3m');
    expect(formatRelative(2 * 60 * 60_000)).toBe('há 2h');
  });
});
