import { useRef, useState } from 'react'
import { Upload, Loader2, X } from 'lucide-react'
import { api } from '@/lib/api'

interface LogoUploadProps {
  value: string | null
  onChange: (url: string | null) => void
  label?: string
}

/**
 * Upload de logo (tenant ou cabinet). Envoie le fichier à POST /platform/brand/logo
 * (stocké en base, servi par /public/brand/:id) puis remonte l'URL absolue —
 * réutilisée comme logoUrl du tenant/cabinet et affichée dans les emails.
 */
export function LogoUpload({ value, onChange, label = 'Logo' }: LogoUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api.post<{ data: { url: string } }>('/platform/brand/logo', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      onChange(res.data.data.url)
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { error?: string } } }
      setError(ax.response?.data?.error ?? 'Échec de l\'upload')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{label}</label>
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
          {value
            ? <img src={value} alt="logo" className="h-full w-full object-contain" />
            : <Upload className="h-5 w-5 text-gray-400" />}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploading ? 'Envoi…' : 'Choisir une image'}
          </button>
          {value && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm text-gray-500 hover:text-red-600"
            >
              <X className="h-4 w-4" /> Retirer
            </button>
          )}
        </div>
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden" onChange={onPick} />
      </div>
      <p className="mt-1.5 text-xs text-gray-400">PNG, JPEG, WEBP ou GIF · 2 Mo max</p>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  )
}
