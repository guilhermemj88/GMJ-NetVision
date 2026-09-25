'use client';

import type { TechnicalLed } from './physical-technical';
import type {
  FixedFaceplateRegion,
  FixedFaceplateSpec,
  FixedFaceplateZone,
} from './physical-fixed-faceplate';

interface Props {
  spec: FixedFaceplateSpec;
  /** Modelo impresso na serigrafia (vem do template/catálogo, nunca inventado). */
  model: string;
  manufacturer?: string | null;
  /** px por unidade de grade do chassi (mesma escala das portas e âncoras). */
  scale: number;
  /** Caixa do desenho em pixels (chassi × escala). */
  width: number;
  height: number;
  /** Regiões dos grupos: MESMA geometria das portas desenhadas. */
  regions: readonly FixedFaceplateRegion[];
  leds: readonly TechnicalLed[];
}

/**
 * Chassi frontal **vetorial** de um equipamento fixo (visão técnica).
 *
 * Desenha só a "carcaça" do equipamento — moldura fina, orelhas de rack com
 * parafusos, serigrafia de marca/modelo, LEDs de status, divisores sutis das
 * regiões de portas e ventilação localizada. Nenhuma imagem raster: é CSS/SVG
 * puro na linguagem escura de NOC/DCIM.
 *
 * As **portas continuam sendo desenhadas** pelo `PhysicalPortShape`, na mesma
 * escala e no mesmo sistema de coordenadas do painel: o faceplate recebe apenas
 * a zona de cada região (derivada das portas já posicionadas) para desenhar os
 * divisores e as legendas. Nada aqui é clicável (a camada é decorativa e
 * `pointer-events: none`).
 */
export function FixedTechnicalFaceplate({
  spec,
  model,
  manufacturer,
  scale,
  width,
  height,
  regions,
  leds,
}: Props) {
  const zone = (value: FixedFaceplateZone) => ({
    left: Math.round(value.x * scale),
    top: Math.round(value.y * scale),
    width: Math.round(value.width * scale),
    height: Math.round(value.height * scale),
  });

  const brand = spec.brand ? zone(spec.brand) : null;
  const ledZone = spec.leds ? zone(spec.leds) : null;

  return (
    <div
      className="physical-fixed-chassis"
      data-faceplate={spec.catalogKey}
      style={{ width, height }}
      aria-hidden="true"
    >
      <span className="physical-fixed-frame" />
      <span className="physical-fixed-chassis__ear is-left" />
      <span className="physical-fixed-chassis__ear is-right" />
      <span className="physical-fixed-screw is-left" />
      <span className="physical-fixed-screw is-right" />

      {brand ? (
        <span className="physical-fixed-chassis__brand" style={brand}>
          <span className="physical-technical-brand">
            <i />
            {manufacturer?.trim() || 'HUAWEI'}
          </span>
          <b>{model}</b>
        </span>
      ) : null}

      {ledZone ? (
        <span className="physical-technical-leds" style={ledZone}>
          {leds.map((led) => (
            <span key={led.label}>
              <i className={`led-${led.tone}`} />
              {led.label}
            </span>
          ))}
        </span>
      ) : null}

      {regions.map((region, index) => (
        <span
          key={region.key}
          className={`physical-fixed-bay role-${region.role}`}
          data-bay-key={region.key}
          data-bay-role={region.role}
          data-first={index === 0 ? 'true' : undefined}
          style={zone(region.zone)}
        >
          <span className="physical-fixed-bay__label">
            {region.label}
            {region.range ? <b>{region.range}</b> : null}
          </span>
          {region.interfaceRange ? (
            <em className="physical-fixed-bay__interface">{region.interfaceRange}</em>
          ) : null}
        </span>
      ))}

      {(spec.vents ?? []).map((vent, index) => (
        <span key={`vent-${index}`} className="physical-fixed-vent" style={zone(vent)} />
      ))}
    </div>
  );
}
