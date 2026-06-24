import type { ReactElement, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';

// Renders markdown with the app's design tokens. The project has no
// @tailwindcss/typography plugin (and Tailwind preflight strips default element
// styles), so we map each element explicitly. react-markdown is XSS-safe by
// default — it does not render raw HTML.
type NodeProps = { children?: ReactNode };
type AnchorProps = NodeProps & { href?: string };

const components = {
  h1: (p: NodeProps) => <h1 className="text-xl font-semibold text-foreground mt-4 mb-2 first:mt-0" {...p} />,
  h2: (p: NodeProps) => <h2 className="text-lg font-semibold text-foreground mt-4 mb-2 first:mt-0" {...p} />,
  h3: (p: NodeProps) => <h3 className="text-base font-semibold text-foreground mt-3 mb-1.5" {...p} />,
  p: (p: NodeProps) => <p className="text-foreground leading-relaxed my-2" {...p} />,
  ul: (p: NodeProps) => <ul className="list-disc pl-5 my-2 space-y-1 text-foreground" {...p} />,
  ol: (p: NodeProps) => <ol className="list-decimal pl-5 my-2 space-y-1 text-foreground" {...p} />,
  li: (p: NodeProps) => <li className="leading-relaxed" {...p} />,
  a: ({ href, children }: AnchorProps) => (
    <a className="btn-link" href={href} target="_blank" rel="noreferrer noopener">{children}</a>
  ),
  strong: (p: NodeProps) => <strong className="font-semibold text-foreground" {...p} />,
  em: (p: NodeProps) => <em className="italic" {...p} />,
  blockquote: (p: NodeProps) => (
    <blockquote className="border-l-2 border-border pl-3 my-2 text-muted-foreground" {...p} />
  ),
  code: (p: NodeProps) => <code className="bg-muted rounded px-1 py-0.5 text-sm" {...p} />,
  pre: (p: NodeProps) => <pre className="bg-muted rounded-md p-3 my-2 overflow-x-auto text-sm" {...p} />,
  hr: () => <hr className="border-border my-3" />,
};

export default function Markdown({ children }: { children: string }): ReactElement {
  return <ReactMarkdown components={components}>{children}</ReactMarkdown>;
}
