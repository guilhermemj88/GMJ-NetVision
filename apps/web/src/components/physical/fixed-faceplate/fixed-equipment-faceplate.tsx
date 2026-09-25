'use client';

import type { PanelLayout } from '../physical-panel-layout';
import type { TechnicalLed } from '../physical-technical';
import {
  type FixedFaceplateChrome,
  type FixedFaceplateRegion,
  type FixedFaceplateZone,
  FIXED_CHASSIS_PX,
} from './fixed-faceplate-layout';
import type { FixedFaceplateVisualProfile } from './fixed-faceplate-profile';
import { fixedFaceplateGroupCaption } from './fixed-faceplate-profile';
import {
  FixedFaceplateLcd,
  FixedFaceplateSummary,
  FixedFaceplateVents,
} from './fixed-faceplate-decoration';
import { FixedFaceplateHeader } from './fixed-faceplate-header';
import { FixedFaceplateRackEar } from './fixed-faceplate-rack-ear';

interface Props {
  profile: FixedFaceplateVisualProfile;
  /** chrome já convertido em unidades (mesma escala das portas) */
  chrome: FixedFaceplateChrome;
  /** layout visual já reposicionado pelo motor */
  layout: Pick<PanelLayout, 'width' | 'gridHeight'>;
  /** regiões dos grupos (mesma geometria das portas desenhadas) */
  regions: readonly FixedFaceplateRegion[];
  leds: readonly TechnicalLed[];
  /** modelo impresso na serigrafia (template/catálogo) */
  model: string;
  heightU: number;
  /** texto do rodapé de resumo (contagem de portas etc.) */
  summary: string;
}

/**
 * Faceplate **fixo** no estilo da biblioteca visual (MagicPatterns):
 * `EquipmentChassis` + `RackEar` + `ChassisHeader` + `StatusLeds` +
 * `FixedPortPanel`.
 *
 * Camada 100% decorativa (`aria-hidden` + `pointer-events: none`): as portas
 * continuam sendo desenhadas pelo `PhysicalPortShape`, na MESMA escala e no
 * MESMO sistema de coordenadas — desenho = hitbox = `PhysicalPort.id` = âncora
 * do cabo. O faceplate só desenha carcaça, cabeçalho, orelhas, LCD, legendas de
 * bloco, ventilação e rodapé.
 */
export function FixedEquipmentFaceplate({
  profile,
  chrome,
  layout,
  regions,
  leds,
  model,
  heightU,
  summary,
}: Props) {
  const scale = chrome.scale;
  const chassisWidth = Math.round(layout.width * scale);
  const chassisHeight = Math.round(layout.gridHeight * scale);
  const earWidth = profile.showRackEars ? FIXED_CHASSIS_PX.earWidth : 0;
  const bodyWidth = chassisWidth - earWidth * 2;
  const padX = FIXED_CHASSIS_PX.bodyPadX;
  const headerTop = FIXED_CHASSIS_PX.bodyPadTop;
  const panelTop = headerTop + FIXED_CHASSIS_PX.headerHeight + FIXED_CHASSIS_PX.headerGap;
  const belowPanel = FIXED_CHASSIS_PX.summaryHeight + FIXED_CHASSIS_PX.bodyPadBottomExtra;
  const panelHeight = Math.max(12, chassisHeight - panelTop - belowPanel);
  const lcdHeight = Math.min(FIXED_CHASSIS_PX.lcdHeight, panelHeight - 2);

  const zone = (value: FixedFaceplateZone) => ({
    left: Math.round(value.x * scale),
    top: Math.round(value.y * scale),
    width: Math.max(4, Math.round(value.width * scale)),
    height: Math.max(4, Math.round(value.height * scale)),
  });

  return (
    <div
      className="fixed-equipment-faceplate"
      data-faceplate={profile.catalogKey}
      data-vendor={profile.vendorStyle}
      style={{ width: chassisWidth, height: chassisHeight }}
      aria-hidden="true"
    >
      {profile.showRackEars ? (
        <FixedFaceplateRackEar side="left" height={chassisHeight} />
      ) : null}
      <span
        className="fixed-equipment-faceplate__body"
        style={{ left: earWidth, width: bodyWidth, height: chassisHeight }}
      >
        <span
          className="fixed-equipment-faceplate__panel"
          style={{
            left: padX,
            top: panelTop,
            width: Math.max(8, bodyWidth - padX * 2),
            height: panelHeight,
          }}
        />
        <span style={{ position: 'absolute', left: padX, top: headerTop, right: padX, display: 'block' }}>
          <FixedFaceplateHeader profile={profile} model={model} heightU={heightU} leds={leds} />
        </span>
        {profile.showLcd ? (
          <FixedFaceplateLcd
            style={{
              left: padX + 4,
              top: panelTop + Math.round((panelHeight - lcdHeight) / 2),
              width: FIXED_CHASSIS_PX.lcdWidth,
              height: lcdHeight,
            }}
          />
        ) : null}
        {regions.map((region) => {
          const caption = fixedFaceplateGroupCaption(profile, region);
          return (
            <span
              key={region.key}
              className={`fixed-faceplate__group role-${region.role}`}
              data-group-key={region.key}
              data-group-role={region.role}
              data-group-management={
                profile.groupPresentation?.[region.key]?.management ? 'true' : undefined
              }
              style={zone(region.zone)}
            >
              {caption === null ? null : (
                <span className="fixed-faceplate__caption">
                  {caption}
                  {region.range ? <b>{region.range}</b> : null}
                </span>
              )}
              {region.interfaceRange ? (
                <em className="fixed-faceplate__interface">{region.interfaceRange}</em>
              ) : null}
            </span>
          );
        })}
        <FixedFaceplateVents zones={profile.ventilation ?? []} scale={scale} />
        <FixedFaceplateSummary text={summary} />
      </span>
      {profile.showRackEars ? (
        <FixedFaceplateRackEar side="right" height={chassisHeight} />
      ) : null}
    </div>
  );
}
