import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

/**
 * Rendu markdown des réponses de l'assistant IA (titres, gras, listes, tableaux,
 * code…). Les styles sont passés explicitement par composant — pas de dépendance
 * au plugin Tailwind Typography — et calibrés pour une bulle de chat étroite.
 */
const components: Components = {
  h1: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-bold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-bold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-2 mb-1 text-[13px] font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 text-[13px] font-semibold first:mt-0">{children}</h4>,
  p:  ({ children }) => <p className="my-1 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-border pl-2 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-border" />,
  code: ({ className, children }) => {
    const isBlock = (className ?? '').includes('language-')
    return isBlock
      ? <code className="block overflow-x-auto rounded bg-black/10 p-2 font-mono text-xs">{children}</code>
      : <code className="rounded bg-black/10 px-1 py-0.5 font-mono text-[12px]">{children}</code>
  },
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-black/5">{children}</thead>,
  th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
}

export default function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
