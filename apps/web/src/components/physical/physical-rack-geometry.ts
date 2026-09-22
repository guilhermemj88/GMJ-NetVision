import type { PhysicalAsset, PhysicalRack } from '@gmj/shared';

/**
 * Dimensões do desenho do rack, centralizadas (nenhum número mágico espalhado).
 *
 * O rack é uma **visão semântica**: a régua mostra as unidades lógicas e uma U
 * pode ficar visualmente mais alta para acomodar um painel cheio de conectores.
 * A expansão é apenas visual — `startU`/`heightU` persistidos nunca mudam.
 */
export const RACK_GEOMETRY = {
  /** Altura base de uma unidade (px) quando nada expande a U. */
  baseUnitHeight: 30,
  /** Largura útil do painel frontal (px) em desktop. */
  rackWidth: 860,
  /** Distância da régua de U até o início do painel. */
  rackLeft: 62,
  /** Respiro interno entre a moldura e o equipamento. */
  frameInset: 16,
  /** Faixa de cabos à direita do rack. */
  laneWidth: 150,
  /** Respiro no topo/rodapé do canvas. */
  topPadding: 22,
  bottomPadding: 40,
  /** Limite de expansão de uma única U (soma das unidades do equipamento). */
  maxAssetHeight: 200,
} as const;

export interface UnitGeometry {
  unit: number;
  top: number;
  height: number;
}

export interface AssetGeometry {
  assetId: string;
  startU: number;
  heightU: number;
  /** topo do equipamento no desenho (px) */
  top: number;
  /** altura desenhada (px), nunca menor que `heightU * baseUnitHeight` */
  height: number;
  /** altura visual calculada pelo painel */
  displayHeight: number;
}

export interface RackGeometry {
  /** altura total do rack (px) */
  height: number;
  /** largura total do canvas (px) */
  width: number;
  /** largura do painel frontal (px) */
  rackWidth: number;
  /** posição horizontal do painel (px) */
  rackLeft: number;
  /** unidades, da maior para a menor (ordem de desenho) */
  units: UnitGeometry[];
  assets: Map<string, AssetGeometry>;
  unitByNumber: Map<number, UnitGeometry>;
}

/**
 * Distribui a altura visual extra do equipamento entre as suas U.
 *
 * A U inicial (mais baixa) recebe a sobra do arredondamento, garantindo que a
 * soma das alturas seja exatamente `displayHeight` e que nenhuma U invada a
 * seguinte.
 */
export function distributeAssetHeight(
  heightU: number,
  displayHeight: number,
  baseUnitHeight: number,
): number[] {
  const units = Math.max(1, Math.round(heightU));
  const total = Math.max(displayHeight, units * baseUnitHeight);
  const perUnit = Math.floor(total / units);
  const heights = Array.from({ length: units }, () => perUnit);
  heights[units - 1] = total - perUnit * (units - 1);
  return heights;
}

/**
 * Constrói a geometria visual do rack: cada U tem uma altura (a base ou a
 * altura expandida do equipamento que a ocupa) e cada equipamento é posicionado
 * por cima das suas U, sem sobreposição.
 */
export function buildRackGeometry(
  rack: Pick<PhysicalRack, 'units' | 'assets'>,
  displayHeights: ReadonlyMap<string, number> = new Map(),
): RackGeometry {
  const base = RACK_GEOMETRY.baseUnitHeight;
  const heights = new Map<number, number>();
  for (let unit = 1; unit <= rack.units; unit += 1) heights.set(unit, base);

  const assets = new Map<string, AssetGeometry>();
  const placements: Array<{ asset: PhysicalAsset; unitHeights: number[] }> = [];
  for (const asset of rack.assets) {
    const startU = Math.max(1, Math.min(rack.units, asset.startU));
    const heightU = Math.max(1, asset.heightU);
    const displayHeight = Math.min(
      RACK_GEOMETRY.maxAssetHeight,
      Math.max(displayHeights.get(asset.id) ?? 0, heightU * base),
    );
    const unitHeights = distributeAssetHeight(heightU, displayHeight, base);
    for (let index = 0; index < heightU; index += 1) {
      const unit = startU + index;
      if (unit > rack.units) break;
      heights.set(unit, Math.max(heights.get(unit) ?? base, unitHeights[index] ?? base));
    }
    placements.push({ asset, unitHeights });
  }

  const units: UnitGeometry[] = [];
  let top = RACK_GEOMETRY.topPadding;
  for (let unit = rack.units; unit >= 1; unit -= 1) {
    const height = heights.get(unit) ?? base;
    units.push({ unit, top, height });
    top += height;
  }
  const unitByNumber = new Map(units.map((entry) => [entry.unit, entry]));

  for (const { asset, unitHeights } of placements) {
    const startU = Math.max(1, Math.min(rack.units, asset.startU));
    const endU = startU + Math.max(1, asset.heightU) - 1;
    const topUnit = unitByNumber.get(endU);
    const bottomUnit = unitByNumber.get(startU);
    if (!topUnit || !bottomUnit) continue;
    assets.set(asset.id, {
      assetId: asset.id,
      startU,
      heightU: Math.max(1, asset.heightU),
      top: topUnit.top,
      height: bottomUnit.top + bottomUnit.height - topUnit.top,
      displayHeight: unitHeights.reduce((sum, value) => sum + value, 0),
    });
  }

  return {
    height: top + RACK_GEOMETRY.bottomPadding,
    width: RACK_GEOMETRY.rackLeft + RACK_GEOMETRY.rackWidth + RACK_GEOMETRY.laneWidth + 24,
    rackWidth: RACK_GEOMETRY.rackWidth,
    rackLeft: RACK_GEOMETRY.rackLeft,
    units,
    assets,
    unitByNumber,
  };
}

/** Escala px por unidade de grade para um painel com a largura disponível. */
export function panelScale(panelWidthGrid: number, panelPixelWidth: number): number {
  if (panelWidthGrid <= 0) return 1;
  return panelPixelWidth / panelWidthGrid;
}
