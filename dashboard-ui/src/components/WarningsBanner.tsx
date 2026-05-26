import type { ReactElement } from 'react';

interface Props {
  warnings: string[];
}

export default function WarningsBanner({ warnings }: Props): ReactElement | null {
  if (!warnings || warnings.length === 0) return null;
  return (
    <aside
      className="rounded-md border border-warning-200 bg-warning-50 text-warning-900 px-3 py-2"
      role="status"
    >
      <h3 className="text-sm font-semibold mb-1">The model flagged these items</h3>
      <ul className="ml-4 list-disc text-sm space-y-0.5">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </aside>
  );
}
