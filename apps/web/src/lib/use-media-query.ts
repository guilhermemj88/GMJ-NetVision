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

/**
 * Mesma condicao do shell mobile em `app/mobile-responsive.css`: celular em pe
 * (`<= 720px`) ou celular deitado (largura curta e altura baixa). Em JS ela
 * decide o enquadramento do canvas, porque o viewport salvo no mapa foi
 * escolhido numa tela grande e nao serve para um aparelho pequeno.
 */
export const MOBILE_SHELL_QUERY = '(max-width: 720px), (max-width: 1024px) and (max-height: 500px)';
