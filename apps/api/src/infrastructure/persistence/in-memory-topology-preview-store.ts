import type { LldpTopologyPreview } from '@gmj/shared';
import type { TopologyPreviewStore, TopologyRawDiscoveryResult } from '../../domain/ports';

/** Demo/test implementation: keeps previews in process memory only. */
export class InMemoryTopologyPreviewStore implements TopologyPreviewStore {
  private readonly previews = new Map<string, LldpTopologyPreview>();

  save(preview: LldpTopologyPreview, _rawResults: TopologyRawDiscoveryResult[]): void {
    this.previews.set(preview.id, structuredClone(preview));
  }

  load(previewId: string): LldpTopologyPreview | null {
    const preview = this.previews.get(previewId);
    return preview ? structuredClone(preview) : null;
  }
}
