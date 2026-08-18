'use client';

import { useParams } from 'next/navigation';
import { PublicViewer } from '@/components/public-viewer';

export default function PublicMapPage() {
  const { token } = useParams<{ token: string }>();
  return <PublicViewer token={token} kind="MAP" />;
}
