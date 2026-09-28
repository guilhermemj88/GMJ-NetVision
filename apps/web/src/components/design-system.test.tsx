/* @vitest-environment jsdom */

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfirmDialog,
  EmptyState,
  MetaFact,
  ModuleHeader,
  Panel,
  PanelSection,
  SearchInput,
  SegmentedControl,
  StatusPill,
} from '@gmj/ui';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('NetVision visual system', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(element: ReactElement) {
    act(() => root.render(element));
  }

  it('StatusPill expõe estado por classe, texto e forma própria', () => {
    render(
      <div>
        <StatusPill status="UP" />
        <StatusPill status="DOWN" />
        <StatusPill status="WARNING" />
        <StatusPill status="UNKNOWN" />
        <StatusPill status="DISABLED" />
      </div>,
    );

    const statuses = [...container.querySelectorAll('.nv-status')];
    expect(statuses).toHaveLength(5);
    expect(statuses.map((node) => node.textContent)).toEqual([
      'UP',
      'DOWN',
      'WARNING',
      'UNKNOWN',
      'DISABLED',
    ]);
    expect(container.querySelector('.nv-status--down .nv-status__mark')).not.toBeNull();
    expect(container.querySelector('.nv-status--warning .nv-status__mark')).not.toBeNull();
  });

  it('StatusPill aceita rótulo e detalhe técnico sem perder a semântica', () => {
    render(<StatusPill status="DOWN" label="Fora de operação" detail="IDLE" />);

    expect(container.querySelector('.nv-status--down')?.textContent).toBe('Fora de operaçãoIDLE');
  });

  it('SegmentedControl marca o valor atual e emite a troca', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Preset"
        value="TOPOLOGIA"
        options={[
          { value: 'OPERACIONAL', label: 'Operacional' },
          { value: 'TOPOLOGIA', label: 'Topologia' },
        ]}
        ariaLabel="Preset de visualização"
        onChange={onChange}
      />,
    );

    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    act(() => buttons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith('OPERACIONAL');
  });

  it('SearchInput é controlado e publica cada digitação', () => {
    const onChange = vi.fn();
    render(<SearchInput value="core" placeholder="Buscar host" onChange={onChange} />);

    const input = container.querySelector('input')!;
    expect(input.value).toBe('core');
    expect(input.getAttribute('aria-label')).toBe('Buscar host');

    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(input, 'core-bh');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('core-bh');
  });

  it('EmptyState sempre comunica título, motivo e próximo passo', () => {
    render(
      <EmptyState
        title="Nenhum POP cadastrado"
        description="O inventário físico começa por um POP."
        action={<button type="button">Criar POP</button>}
        hints={<span>0 racks</span>}
      />,
    );

    expect(container.querySelector('.nv-empty__title')?.textContent).toBe('Nenhum POP cadastrado');
    expect(container.querySelector('.nv-empty__description')?.textContent).toBe(
      'O inventário físico começa por um POP.',
    );
    expect(container.querySelector('.nv-empty__action button')?.textContent).toBe('Criar POP');
    expect(container.querySelector('.nv-empty__hints')?.textContent).toBe('0 racks');
  });

  it('ModuleHeader agrupa identidade, fatos, ações e toolbar', () => {
    render(
      <ModuleHeader
        eyebrow="INVENTÁRIO GLOBAL"
        title="Hosts"
        subtitle="Equipamentos monitorados e não monitorados."
        meta={<MetaFact label="hosts" value="13" tone="up" />}
        actions={<button type="button">Adicionar host</button>}
        toolbar={<span data-testid="toolbar">filtros</span>}
      />,
    );

    expect(container.querySelector('h1')?.textContent).toBe('Hosts');
    expect(container.querySelector('.nv-module-header__eyebrow')?.textContent).toBe(
      'INVENTÁRIO GLOBAL',
    );
    expect(container.querySelector('.nv-fact--up strong')?.textContent).toBe('13');
    expect(container.querySelector('.nv-module-header__actions button')?.textContent).toBe(
      'Adicionar host',
    );
    expect(container.querySelector('[data-testid="toolbar"]')).not.toBeNull();
  });

  it('Panel e PanelSection organizam conteúdo lateral com fechamento', () => {
    const onClose = vi.fn();
    render(
      <Panel
        eyebrow="EQUIPAMENTO"
        title="core-bh-01"
        onClose={onClose}
        footer={<button type="button">Salvar</button>}
      >
        <PanelSection title="IDENTIDADE">conteúdo</PanelSection>
      </Panel>,
    );

    expect(container.querySelector('.nv-panel__identity h2')?.textContent).toBe('core-bh-01');
    expect(container.querySelector('.nv-panel-section__title')?.textContent).toBe('IDENTIDADE');

    act(() => container.querySelector<HTMLButtonElement>('.nv-panel__close')!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ConfirmDialog só existe aberto e separa confirmar de cancelar', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open={false} title="Excluir enlace" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(container.querySelector('.nv-confirm')).toBeNull();

    render(
      <ConfirmDialog
        open
        title="Excluir enlace"
        description="O enlace será removido do mapa."
        confirmLabel="Excluir"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const dialog = container.querySelector('.nv-confirm')!;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toContain('O enlace será removido do mapa.');

    const [cancel, confirm] = [...container.querySelectorAll('button')];
    act(() => cancel!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('ConfirmDialog bloqueia a ação enquanto está pendente', () => {
    render(<ConfirmDialog open pending title="Excluir" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(
      [...container.querySelectorAll('button')].every((button) => button.disabled),
    ).toBe(true);
  });
});
