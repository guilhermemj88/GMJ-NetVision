import { FIXED_CHASSIS_PX } from './fixed-faceplate-layout';

/**
 * Orelha de rack do chassi fixo (coluna lateral com os dois furos), como no
 * `RackEar` da biblioteca visual. É só aparência: nada clicável.
 */
export function FixedFaceplateRackEar({
  side,
  height,
}: {
  side: 'left' | 'right';
  height: number;
}) {
  return (
    <span
      className={`fixed-faceplate__ear is-${side}`}
      style={{ width: FIXED_CHASSIS_PX.earWidth, height }}
      aria-hidden="true"
    >
      <span className="fixed-faceplate__ear-hole" />
      <span className="fixed-faceplate__ear-hole" />
    </span>
  );
}
