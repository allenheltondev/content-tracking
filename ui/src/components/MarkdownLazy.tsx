import type { ReactElement } from 'react';
import { lazy, Suspense } from 'react';

// Lazy boundary for the markdown renderer so react-markdown (+ its remark deps)
// ship as a separate chunk, loaded only when an answer or blog preview actually
// renders — keeping it out of the initial dashboard bundle. While the chunk
// loads, fall back to the raw text (which is what the streaming view shows
// anyway), so there's no layout flash.
const Markdown = lazy(() => import('./Markdown'));

export default function MarkdownLazy({ children }: { children: string }): ReactElement {
  return (
    <Suspense fallback={<p className="text-foreground whitespace-pre-wrap">{children}</p>}>
      <Markdown>{children}</Markdown>
    </Suspense>
  );
}
