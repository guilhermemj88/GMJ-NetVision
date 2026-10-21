'use client';

import { NetworkDeviceIcon } from '@/components/network-device-icon';
import {
  NetworkDeviceGlyphV2,
  resolveDeviceGlyphV2,
  type DeviceGlyphV2Type,
} from '@/components/network-device-glyphs-v2';
import {
  DEVICE_ICON_OPTIONS,
  DEVICE_ICON_TYPES,
  type NetworkDeviceIconType,
} from '@/lib/device-appearance';
import { MapVisualCanvasSection } from './v2-canvas-section';

/**
 * MAP-VISUAL-V2 — laboratório (rota /map-visual-preview).
 *
 * Fase A: catálogo de glifos V1 × V2, comparação do CORE_SWITCH candidato e
 * matriz BNG normal/compacta. Fase B: canvases com enlaces inteligentes
 * (V1 × V2), cenários simples e denso, rótulos, simulações e painel lateral.
 * Fase C: pré-integração operacional — espessura compensada por zoom, offsets
 * manuais da V1, anticolisão sobre geometria REAL sanitizada, contrato de
 * seleção do ContextDrawer e flag visual por mapa. Tudo mock, sem API e sem
 * tocar no mapa operacional. O V1 permanece o padrão do produto.
 */

const ICON_SIZE_STEPS = [16, 24, 32, 48] as const;

type BngMode = 'normal' | 'compact' | 'sugerida';

const LABEL_BY_TYPE = new Map<string, string>(
  DEVICE_ICON_OPTIONS.map((option) => [option.value, option.label]),
);

const LEGACY_TYPES = DEVICE_ICON_TYPES.filter(
  (iconType): iconType is NetworkDeviceIconType => iconType !== 'AUTO',
);

const V2_ROWS = LEGACY_TYPES.filter((iconType) => resolveDeviceGlyphV2(iconType) !== null);
const FALLBACK_ROWS = LEGACY_TYPES.filter((iconType) => resolveDeviceGlyphV2(iconType) === null);

const TYPE_NOTES: Partial<Record<NetworkDeviceIconType, string>> = {
  CORE_SWITCH:
    'Mapeamento provisório: usa o desenho SWITCH. O desenho novo é comparado na seção "CORE_SWITCH — candidato".',
  EDGE_ROUTER: 'Usa o desenho ROUTER do V2.',
};

function deviceColorClass(iconType: string): string {
  return `device-node--type-${iconType.toLowerCase().replaceAll('_', '-')}`;
}

function V1Sample({ iconType, size }: { iconType: NetworkDeviceIconType; size: number }) {
  return (
    <span className={`mv2-sample ${deviceColorClass(iconType)}`}>
      <NetworkDeviceIcon type={iconType} variant="2d" size={size} />
    </span>
  );
}

function V2Sample({
  glyph,
  size,
  label,
  compact = false,
  colorClass,
}: {
  glyph: DeviceGlyphV2Type;
  size: number;
  label?: string;
  compact?: boolean;
  colorClass?: string;
}) {
  return (
    <span className={`mv2-sample ${colorClass ?? ''}`}>
      <NetworkDeviceGlyphV2 type={glyph} size={size} compact={compact} />
      {label ? <span className="mv2-sample__label">{label}</span> : null}
    </span>
  );
}

/** Preferência inicial do operador: compacta nos pequenos, normal em 32/48. */
function bngCompactFor(mode: BngMode, size: number): boolean {
  if (mode === 'compact') return true;
  if (mode === 'normal') return false;
  return size <= 24;
}

export function MapVisualLab() {
  return (
    <div className="mv2-lab">
      <header className="mv2-lab__header">
        <div>
          <h1 className="mv2-lab__title">
            MAP-VISUAL-V2 · Laboratório (Fase A + Fase B + Fase C)
          </h1>
          <p className="mv2-lab__subtitle">
            Fase A: catálogo de glifos V1 × V2 em 16/24/32/48 px, comparação do{' '}
            <strong>CORE_SWITCH</strong> candidato e matriz <strong>BNG</strong> normal/compacta.
            Fase B: canvases com enlaces de linha única (cor por utilização, grossura por
            capacidade, seta na tangente, rótulos inteligentes), cenários simples e denso,
            simulações, LAG demonstrativo e painel lateral. Fase C: pré-integração operacional —
            espessura compensada por zoom, offsets manuais da V1 preservados, anticolisão sobre
            geometria real sanitizada (cenário C), contrato de seleção do ContextDrawer e flag
            visual por mapa. Tudo demonstrativo; nenhum dado real é exibido, gravado ou enviado.
          </p>
        </div>
        <div className="mv2-lab__chips">
          <span className="mv2-chip mv2-chip--ok">V1 intacta</span>
          <span className="mv2-chip mv2-chip--ok">nada publicado</span>
          <span className="mv2-chip mv2-chip--warn">mapeamento CORE_SWITCH provisório</span>
          <span className="mv2-chip">dados DEMONSTRATIVOS</span>
        </div>
      </header>

      <section className="mv2-lab__section" id="catalogo">
        <h2>Catálogo V1 × V2 · 16/24/32/48 px</h2>
        <p className="mv2-lab__hint">
          Contrato visual do V2: viewBox 0 0 64 64, traço <code>currentColor</code>, sem cor
          embutida e traço mais grosso nos tamanhos pequenos (3 px até 20, 2.6 px até 28, 2.2 px
          acima). No V1 o traço é fixo — a comparação mostra a diferença de peso em cada tamanho.
        </p>
        <div className="mv2-catalog">
          <div className="mv2-catalog__row mv2-catalog__row--head">
            <span className="mv2-catalog__head-cell mv2-catalog__head-cell--type">
              Tipo (legado)
            </span>
            <span className="mv2-catalog__head-cell">V1 · 32 px</span>
            <span className="mv2-catalog__head-cell">V2 · 16 px</span>
            <span className="mv2-catalog__head-cell">V2 · 24 px</span>
            <span className="mv2-catalog__head-cell">V2 · 32 px</span>
            <span className="mv2-catalog__head-cell">V2 · 48 px</span>
          </div>

          <div className="mv2-catalog__group">Tipos legados com glifo V2 (11)</div>
          {V2_ROWS.map((legacyType) => {
            const glyph = resolveDeviceGlyphV2(legacyType) as DeviceGlyphV2Type;
            return (
              <div className="mv2-catalog__row" key={legacyType}>
                <div className="mv2-catalog__type">
                  <strong>{LABEL_BY_TYPE.get(legacyType) ?? legacyType}</strong>
                  <code>{legacyType}</code>
                  {TYPE_NOTES[legacyType] ? <em>{TYPE_NOTES[legacyType]}</em> : null}
                </div>
                <div className="mv2-catalog__cell">
                  <V1Sample iconType={legacyType} size={32} />
                </div>
                {ICON_SIZE_STEPS.map((size) =>
                  legacyType === 'CORE_SWITCH' ? (
                    <div className="mv2-catalog__cell" key={size}>
                      <span className="mv2-sample__pair">
                        <V2Sample
                          glyph={glyph}
                          size={size}
                          label="prov."
                          colorClass={deviceColorClass(legacyType)}
                        />
                        <V2Sample
                          glyph="CORE_SWITCH"
                          size={size}
                          label="novo"
                          colorClass={deviceColorClass(legacyType)}
                        />
                      </span>
                    </div>
                  ) : (
                    <div className="mv2-catalog__cell" key={size}>
                      <V2Sample glyph={glyph} size={size} colorClass={deviceColorClass(legacyType)} />
                    </div>
                  ),
                )}
              </div>
            );
          })}

          <div className="mv2-catalog__group">
            Sem glifo V2 — fallback para o V1 (12)
          </div>
          {FALLBACK_ROWS.map((legacyType) => (
            <div className="mv2-catalog__row" key={legacyType}>
              <div className="mv2-catalog__type">
                <strong>{LABEL_BY_TYPE.get(legacyType) ?? legacyType}</strong>
                <code>{legacyType}</code>
                <em>Sem desenho V2: o resolvedor devolve null e o mapa continua no glifo V1.</em>
              </div>
              <div className="mv2-catalog__cell">
                <V1Sample iconType={legacyType} size={32} />
              </div>
              {ICON_SIZE_STEPS.map((size) => (
                <div className="mv2-catalog__cell" key={size}>
                  <span className="mv2-catalog__miss">—</span>
                </div>
              ))}
            </div>
          ))}

          <div className="mv2-catalog__group">PNI — glifo novo, sem tipo legado ainda</div>
          <div className="mv2-catalog__row">
            <div className="mv2-catalog__type">
              <strong>PNI</strong>
              <code>PNI (somente V2)</code>
              <em>
                Não é opção do picker nesta fase; o resolvedor AUTO nunca infere PNI. Selecionável
                apenas quando a taxonomia for aprovada.
              </em>
            </div>
            <div className="mv2-catalog__cell">
              <span className="mv2-catalog__miss">—</span>
            </div>
            {ICON_SIZE_STEPS.map((size) => (
              <div className="mv2-catalog__cell" key={size}>
                <V2Sample glyph="PNI" size={size} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mv2-lab__section" id="core-switch">
        <h2>CORE_SWITCH — candidato × desenho em uso</h2>
        <p className="mv2-lab__hint">
          O glifo novo representa um switch de núcleo com <strong>dois chassis</strong> (camada
          traseira + frontal) e seta dupla. O mapeamento global continua{' '}
          <code>CORE_SWITCH → SWITCH</code> (provisório): compare os dois desenhos e use o
          seletor para avaliar o candidato no React Flow abaixo.
        </p>
        <div className="mv2-compare">
          <div className="mv2-card">
            <div className="mv2-card__head">
              <span className="mv2-card__title">SWITCH — em uso (provisório)</span>
              <span className="mv2-card__badge">desenho atual</span>
            </div>
            <div className="mv2-card__hero">
              <V2Sample glyph="SWITCH" size={112} colorClass={deviceColorClass('CORE_SWITCH')} />
              <span className="mv2-card__hero-caption">
                Um chassi, quatro portas e seta dupla. É o desenho que o equipamento CORE_SWITCH
                recebe hoje por meio do mapeamento provisório.
              </span>
            </div>
            <div className="mv2-strip">
              {ICON_SIZE_STEPS.map((size) => (
                <V2Sample
                  key={size}
                  glyph="SWITCH"
                  size={size}
                  label={`${size} px`}
                  colorClass={deviceColorClass('CORE_SWITCH')}
                />
              ))}
            </div>
          </div>
          <div className="mv2-card mv2-card--candidate">
            <div className="mv2-card__head">
              <span className="mv2-card__title">CORE_SWITCH — novo</span>
              <span className="mv2-card__badge">candidato · avaliação</span>
            </div>
            <div className="mv2-card__hero">
              <V2Sample glyph="CORE_SWITCH" size={112} colorClass={deviceColorClass('CORE_SWITCH')} />
              <span className="mv2-card__hero-caption">
                Segunda camada atrás do chassi frontal: sugere núcleo sem depender de cor,
                distinguindo de SWITCH também em zoom baixo.
              </span>
            </div>
            <div className="mv2-strip">
              {ICON_SIZE_STEPS.map((size) => (
                <V2Sample
                  key={size}
                  glyph="CORE_SWITCH"
                  size={size}
                  label={`${size} px`}
                  colorClass={deviceColorClass('CORE_SWITCH')}
                />
              ))}
            </div>
          </div>
        </div>
        <p className="mv2-lab__note">
          O desenho aplicado ao CORE_SWITCH é escolhido nos controles do canvas (Fase B). A linha{' '}
          <code>CORE_SWITCH: &quot;SWITCH&quot;</code> do módulo oficial foi preservada — a
          ativação global só depois da aprovação visual.
        </p>
      </section>

      <section className="mv2-lab__section" id="bng">
        <h2>BNG — normal × compacta em 16/24/32/48 px</h2>
        <p className="mv2-lab__hint">
          A variante <strong>compacta</strong> é um opt-in do componente (<code>compact</code>);
          ela nunca é escolhida automaticamente. A terceira linha mostra a preferência inicial do
          operador: compacta nos pequenos, normal em 32/48 px.
        </p>
        <div className="mv2-matrix">
          <div className="mv2-catalog__row mv2-catalog__row--head">
            <span className="mv2-catalog__head-cell mv2-catalog__head-cell--type">Variante</span>
            {ICON_SIZE_STEPS.map((size) => (
              <span className="mv2-catalog__head-cell" key={size}>
                {size} px
              </span>
            ))}
            <span className="mv2-catalog__head-cell">112 px (detalhe)</span>
          </div>
          <div className="mv2-catalog__row">
            <div className="mv2-catalog__type">
              <strong>Normal</strong>
              <code>compact=false</code>
              <em>Chassi + tronco ramificando para três assinantes.</em>
            </div>
            {ICON_SIZE_STEPS.map((size) => (
              <div className="mv2-catalog__cell" key={size}>
                <V2Sample
                  glyph="BNG"
                  size={size}
                  label="normal"
                  colorClass={deviceColorClass('BNG')}
                />
              </div>
            ))}
            <div className="mv2-catalog__cell">
              <V2Sample glyph="BNG" size={112} compact={false} colorClass={deviceColorClass('BNG')} />
            </div>
          </div>
          <div className="mv2-catalog__row">
            <div className="mv2-catalog__type">
              <strong>Compacta</strong>
              <code>compact=true</code>
              <em>Tronco curto e um único assinante: menos traços nos tamanhos pequenos.</em>
            </div>
            {ICON_SIZE_STEPS.map((size) => (
              <div className="mv2-catalog__cell" key={size}>
                <V2Sample
                  glyph="BNG"
                  size={size}
                  label="compacta"
                  compact
                  colorClass={deviceColorClass('BNG')}
                />
              </div>
            ))}
            <div className="mv2-catalog__cell">
              <V2Sample glyph="BNG" size={112} compact colorClass={deviceColorClass('BNG')} />
            </div>
          </div>
          <div className="mv2-catalog__row">
            <div className="mv2-catalog__type">
              <strong>Preferência (compacta ≤ 24 px)</strong>
              <code>sugerida · não automática</code>
              <em>O que o seletor do canvas aplica quando escolhido.</em>
            </div>
            {ICON_SIZE_STEPS.map((size) => (
              <div className="mv2-catalog__cell" key={size}>
                <V2Sample
                  glyph="BNG"
                  size={size}
                  label={bngCompactFor('sugerida', size) ? 'compacta' : 'normal'}
                  compact={bngCompactFor('sugerida', size)}
                  colorClass={deviceColorClass('BNG')}
                />
              </div>
            ))}
            <div className="mv2-catalog__cell">
              <V2Sample glyph="BNG" size={112} compact={false} colorClass={deviceColorClass('BNG')} />
            </div>
          </div>
        </div>
        <p className="mv2-lab__note">
          A variante aplicada ao BNG no canvas é escolhida nos controles da Fase B (normal,
          compacta ou preferência ≤ 24 px).
        </p>
      </section>

      <MapVisualCanvasSection />

      <section className="mv2-lab__section" id="notas">
        <h2>Notas e limites desta fase</h2>
        <ul className="mv2-notes">
          <li>
            Mapeamento global segue provisório: <code>resolveDeviceGlyphV2(&apos;CORE_SWITCH&apos;)</code>{' '}
            continua devolvendo <code>SWITCH</code>. Nada foi alterado no módulo oficial por este
            laboratório.
          </li>
          <li>
            Doze tipos legados ainda não têm desenho V2 e caem no glifo V1 (fallback) — nenhum
            equipamento muda de aparência sem decisão explícita.
          </li>
          <li>
            PNI existe como glifo V2, mas não entra no picker nem no resolvedor AUTO nesta fase.
          </li>
          <li>
            Classificação AUTO, tipos persistidos, posições e equipamentos existentes não foram
            tocados.
          </li>
          <li>
            A variante compacta do BNG é opt-in; a preferência “compacta ≤ 24 px / normal ≥ 32 px”
            é apenas uma opção de avaliação deste laboratório.
          </li>
          <li>
            Vetores SVG não perdem definição em telas 2x; o que define a legibilidade é o tamanho
            final em px — por isso a matriz fixa 16/24/32/48.
          </li>
          <li>
            Todos os nós, enlaces, estados, alarmes e históricos são mock e permanecem no
            navegador; nenhum tráfego sintético vai para a API ou para os equipamentos.
          </li>
          <li>
            Fase B — regra de stale: a hipótese inicial da V2 é <strong>três ciclos de coleta</strong>{' '}
            (SNMP padrão de 60s → 180s), parametrizável e ainda sujeita à cadência real. Nenhuma
            classificação de enlace real usa esse número.
          </li>
          <li>
            Fase B — anticolisão de rótulos: versão determinística sobre os dados mock (deslocamento
            perpendicular → formato compacto → ocultação de rótulos secundários; seleção, DOWN e
            alarme nunca são ocultados). Offsets manuais persistidos da V1 <em>não</em> são
            consumidos pelo V2 nesta fase.
          </li>
          <li>
            Fase B — LAG só é agrupado quando os dados mock declaram o grupo;{' '}
            <code>aggregationMode SUM</code> não é tratado como LAG real e circuitos independentes
            entre os mesmos nós nunca são agrupados automaticamente.
          </li>
          <li>
            Fase B — o painel lateral é demonstrativo e usa dados mock; o ContextDrawer de produção
            e os gráficos do MAP-LINK-GRAPHS não foram alterados.
          </li>
        </ul>
      </section>

      <footer className="mv2-lab__footer">
        MAP-VISUAL-V2 · laboratório interno (Fases A e B) · rota disponível apenas em
        desenvolvimento local ou build de preview (<code>NEXT_PUBLIC_PREVIEW_MODE=true</code>). No
        build de produção a rota devolve o conteúdo 404 do framework — nenhum dado ou componente do
        laboratório é servido (o App Router mantém status 200 nesse caso; ver limitações no
        relatório da fase). Nenhum deploy, merge ou restart faz parte deste laboratório; a V2 não
        aparece no mapa operacional nesta fase.
      </footer>
    </div>
  );
}
