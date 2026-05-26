import type { ReactElement } from 'react';

interface Props {
  warnings: string[];
}

export default function WarningsBanner({ warnings }: Props): ReactElement | null {
  if (!warnings || warnings.length === 0) return null;
  return (
    <aside className="warnings-banner" role="status">
      <h3>The model flagged these items</h3>
      <ul>
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </aside>
  );
}
