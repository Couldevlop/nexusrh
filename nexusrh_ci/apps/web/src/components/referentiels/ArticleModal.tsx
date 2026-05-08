/**
 * Modale article juridique — affichée depuis un bulletin de paie (icône ℹ)
 * ou depuis la page Référentiel
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { BookOpen, Scale, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNavigate } from 'react-router-dom'

interface ArticleHit {
  article_id: string; article_numero: string; source: string
  convention_slug?: string; livre?: string; titre?: string
  chapitre?: string; section?: string; titre_article: string
  texte: string; payroll_codes?: string[]
}

interface Props {
  article: ArticleHit
  onClose: () => void
}

export function ArticleModal({ article, onClose }: Props) {
  const navigate = useNavigate()

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <Badge variant={article.source === 'code_travail_ci' ? 'default' : 'secondary'}>
              {article.source === 'code_travail_ci'
                ? <><BookOpen className="h-3 w-3 mr-1" />Code du Travail CI</>
                : <><Scale className="h-3 w-3 mr-1" />{article.convention_slug?.replace(/_/g, ' ') ?? 'Convention Collective'}</>}
            </Badge>
            <span className="text-xs text-muted-foreground">{article.article_numero}</span>
          </div>
          <DialogTitle className="text-base leading-snug">{article.titre_article}</DialogTitle>
        </DialogHeader>

        {/* Fil d'Ariane */}
        {article.livre && (
          <div className="text-xs text-muted-foreground flex flex-wrap gap-1 -mt-2">
            {[article.livre, article.titre, article.chapitre, article.section]
              .filter(Boolean)
              .map((part, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span>›</span>}
                  {part}
                </span>
              ))}
          </div>
        )}

        {/* Texte intégral */}
        <div className="bg-muted/30 rounded-lg p-4 text-sm leading-relaxed whitespace-pre-wrap border-l-4 border-primary/30 mt-2">
          {article.texte}
        </div>

        {/* Rubriques de paie liées */}
        {article.payroll_codes && article.payroll_codes.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap mt-1">
            <span className="text-xs text-muted-foreground">Rubriques paie liées :</span>
            {article.payroll_codes.map(code => (
              <Badge key={code} variant="outline" className="text-xs font-mono">{code}</Badge>
            ))}
          </div>
        )}

        <div className="flex justify-between mt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Fermer</Button>
          <Button variant="outline" size="sm" onClick={() => {
            navigate(`/referentiels?article=${article.article_id}`)
            onClose()
          }}>
            <ExternalLink className="h-3 w-3 mr-1" />Voir dans le référentiel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Bouton "ℹ" à placer sur une ligne de bulletin de paie
 * Usage: <PayrollLineInfo payrollCode="1700" />
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { api } from '@/lib/axios'

export function PayrollLineInfo({ payrollCode }: { payrollCode: string }) {
  const [open, setOpen] = useState(false)

  const { data: articles } = useQuery({
    queryKey: ['payroll-articles', payrollCode],
    queryFn: () => api.get(`/referentiels/payroll/${payrollCode}`).then(r => r.data),
    enabled: open,
    staleTime: 300_000,
  })

  return (
    <>
      <button
        title="Voir le texte de loi correspondant"
        onClick={() => setOpen(true)}
        className="text-primary/60 hover:text-primary transition-colors"
      >
        <Info className="h-3.5 w-3.5" />
      </button>

      {open && articles?.[0] && (
        <ArticleModal article={articles[0]} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
