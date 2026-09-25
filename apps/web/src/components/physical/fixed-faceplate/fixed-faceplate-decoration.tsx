import type { FixedFaceplateZone } from './fixed-faceplate-layout';
import { FIXED_CHASSIS_PX } from './fixed-faceplate-layout';

/**
 * Decoração do chassi fixo: LCD dos CCR, ventilação localizada e o rodapé de
 * resumo. Tudo CSS/SVG puro, sem interação — a biblioteca visual usa os mesmos
 * elementos (`FixedPortPanel`/`FanGlyph`).
 */

/** LCD frontal do MikroTik CCR (tela decorativa, como no protótipo). */
export function FixedFaceplateLcd({ style }: { style?: React.CSSProperties }) {
  return (
    <span className="fixed-faceplate__lcd" style={style} aria-hidden="true">
      <span className="fixed-faceplate__lcd-screen">
        <b>RouterOS</b>
        <i />
        <i />
      </span>
      <span className="fixed-faceplate__lcd-label">LCD</span>
    </span>
  );
}

/** Ventilação localizada: bloco pequeno de fendas, nunca uma faixa vazia. */
export function FixedFaceplateVents({
  zones,
  scale,
}: {
  zones: readonly FixedFaceplateZone[];
  scale: number;
}) {
  return (
    <>
      {zones.map((zone, index) => (
        <span
          key={`vent-${index}`}
          className="fixed-faceplate__vent"
          style={{
            left: Math.round(zone.x * scale),
            top: Math.round(zone.y * scale),
            width: Math.max(4, Math.round(zone.width * scale)),
            height: Math.max(4, Math.round(zone.height * scale)),
          }}
          aria-hidden="true"
        />
      ))}
    </>
  );
}

/** Rodapé de resumo, alinhado à direita (linha fina e discreta). */
export function FixedFaceplateSummary({ text }: { text: string }) {
  return (
    <span
      className="fixed-faceplate__summary"
      style={{ height: FIXED_CHASSIS_PX.summaryHeight }}
      aria-hidden="true"
    >
      {text}
    </span>
  );
}
