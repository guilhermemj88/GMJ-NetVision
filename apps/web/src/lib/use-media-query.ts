'use client';

import { useEffect, useState } from 'react';

/**
 * Tracks a CSS media query without server-side rendering mismatches.
 * The initial value is always `false` on the server and on the first
 * client render; the subscription then synchronizes the actual state.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}
