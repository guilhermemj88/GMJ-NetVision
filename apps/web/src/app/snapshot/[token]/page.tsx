import { SnapshotView } from '@/components/snapshot-view';
import { SnapshotReadySignal } from '@/components/snapshot-ready';
import { getSnapshotChart } from '@/lib/snapshot-api';
import '../snapshot.css';

export const dynamic = 'force-dynamic';

/**
 * Pagina interna do snapshot (1200x720) aberta pelo renderer isolado. Nao
 * passa pelo login: o acesso e um token ASSINADO e curto, com escopo de uma
 * interface/periodo, que só o renderer recebe.
 */
export default async function SnapshotTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const data = await getSnapshotChart(token).catch(() => null);
  if (!data) {
    return (
      <main className="snapshot-canvas snapshot-canvas--empty">
        {/* Sem dados o PNG ainda sai (estado vazio), sem esperar o timeout do renderer. */}
        <SnapshotReadySignal delayMs={50} />
        <p>Snapshot expirado ou indisponível.</p>
      </main>
    );
  }
  return <SnapshotView data={data} />;
}
