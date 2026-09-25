import type { TechnicalLed } from '../physical-technical';
import { FIXED_CHASSIS_PX } from './fixed-faceplate-layout';
import type { FixedFaceplateVendor, FixedFaceplateVisualProfile } from './fixed-faceplate-profile';

/**
 * Cabeçalho interno do chassi (`ChassisHeader` + `StatusLeds` da biblioteca
 * visual): marca com o ponto do fabricante, modelo, LEDs rotulados, série e o
 * chip de altura em U. Tudo aparência — a identidade do ativo continua no
 * cabeçalho da faceplate do NetVision.
 */

const BRANDS: Record<FixedFaceplateVendor, { label: string; mark: string }> = {
  HUAWEI: { label: 'HUAWEI', mark: '#d7263d' },
  MIKROTIK: { label: 'MikroTik', mark: '#cbd5e1' },
};

interface Props {
  profile: FixedFaceplateVisualProfile;
  model: string;
  heightU: number;
  leds: readonly TechnicalLed[];
}

export function FixedFaceplateHeader({ profile, model, heightU, leds }: Props) {
  const brand = BRANDS[profile.vendorStyle];
  return (
    <div
      className="fixed-faceplate__header"
      style={{ height: FIXED_CHASSIS_PX.headerHeight }}
      aria-hidden="true"
    >
      <span className="fixed-faceplate__brand">
        <i style={{ background: brand.mark }} />
        {brand.label}
      </span>
      <span className="fixed-faceplate__model">{profile.modelLabel ?? model}</span>
      {profile.showStatusLeds === false ? null : (
        <span className="physical-technical-leds fixed-faceplate__leds">
          {leds.map((led) => (
            <span key={led.label}>
              <i className={`led-${led.tone}`} />
              {led.label}
            </span>
          ))}
        </span>
      )}
      <span className="fixed-faceplate__meta">
        {profile.seriesLabel ? <span>{profile.seriesLabel}</span> : null}
        <span className="fixed-faceplate__chip">{heightU}U</span>
      </span>
    </div>
  );
}
