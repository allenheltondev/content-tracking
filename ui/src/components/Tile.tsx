import type { ReactElement } from 'react';

// The one stat card. Superset of the variants that used to live in
// CampaignDetail, CampaignReport, and the engagement sections:
//  - tone="warning" colors the value for needs-attention stats
//  - hint renders as a cursor-help title on the label
//  - slot drops a data-booked-slot anchor the extension decorates
//  - className appends container classes (print styles etc.)
export default function Tile({
  label,
  value,
  sublabel,
  tone = 'default',
  hint,
  slot,
  className,
}: {
  label: string;
  value: string;
  sublabel?: string | null;
  tone?: 'default' | 'warning';
  hint?: string;
  slot?: string;
  className?: string;
}): ReactElement {
  const toneClass = tone === 'warning' ? 'text-warning-700' : 'text-foreground';
  return (
    <div
      className={`card card-body !py-3${slot ? ' relative' : ''}${className ? ` ${className}` : ''}`}
    >
      {slot && (
        <span
          data-booked-slot={slot}
          className="absolute top-2 right-2 flex items-center"
        />
      )}
      <span
        className={`text-xs uppercase tracking-wide text-muted-foreground${
          hint ? ' cursor-help' : ''
        }`}
        title={hint}
      >
        {label}
      </span>
      <span className={`text-2xl font-semibold ${toneClass} mt-1 block`}>{value}</span>
      {sublabel && (
        <span className="text-xs text-muted-foreground mt-0.5 block truncate">{sublabel}</span>
      )}
    </div>
  );
}
