import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import { BRIEF_FILE_ACCEPT } from '../api/briefs';

interface Props {
  onFile: (file: File) => void;
  disabled?: boolean;
  children?: ReactNode;
}

// Drag-and-drop area with a file input, for brief uploads.
export default function BriefDropzone({ onFile, disabled, children }: Props): ReactElement {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
        dragOver ? 'border-primary-500 bg-primary-50' : 'border-border bg-muted/50'
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const dropped = e.dataTransfer.files[0];
        if (dropped && !disabled) onFile(dropped);
      }}
    >
      <p className="text-muted-foreground mb-2">Drag a brief here, or pick a file.</p>
      <input
        type="file"
        aria-label="Brief file"
        accept={BRIEF_FILE_ACCEPT}
        className="text-sm"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = '';
          if (picked) onFile(picked);
        }}
        disabled={disabled}
      />
      {children}
    </div>
  );
}
