import { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, X, File, CheckCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FileUploadProps {
  onFilesSelected: (files: File[]) => void
  accept?: Record<string, string[]>
  maxFiles?: number
  maxSize?: number // bytes
  className?: string
  label?: string
}

export function FileUpload({
  onFilesSelected,
  accept = {
    'application/pdf': ['.pdf'],
    'image/*': ['.png', '.jpg', '.jpeg'],
  },
  maxFiles = 5,
  maxSize = 10 * 1024 * 1024, // 10MB
  className,
  label = 'Glissez des fichiers ici ou cliquez pour sélectionner',
}: FileUploadProps) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [errors, setErrors] = useState<string[]>([])

  const onDrop = useCallback(
    (acceptedFiles: File[], rejectedFiles: { file: File; errors: { message: string }[] }[]) => {
      setErrors([])

      if (rejectedFiles.length > 0) {
        setErrors(rejectedFiles.map((r) => `${r.file.name}: ${r.errors[0]?.message ?? 'Erreur'}`))
      }

      if (acceptedFiles.length > 0) {
        const updated = [...selectedFiles, ...acceptedFiles].slice(0, maxFiles)
        setSelectedFiles(updated)
        onFilesSelected(updated)
      }
    },
    [selectedFiles, maxFiles, onFilesSelected]
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept,
    maxFiles,
    maxSize,
  })

  const removeFile = (idx: number) => {
    const updated = selectedFiles.filter((_, i) => i !== idx)
    setSelectedFiles(updated)
    onFilesSelected(updated)
  }

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div className={className}>
      <div
        {...getRootProps()}
        className={cn(
          'border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors',
          isDragActive
            ? 'border-indigo-400 bg-indigo-50'
            : 'border-gray-300 hover:border-indigo-400 hover:bg-gray-50'
        )}
      >
        <input {...getInputProps()} />
        <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
        <p className="text-sm text-gray-600">{label}</p>
        <p className="text-xs text-gray-400 mt-1">
          Max {maxFiles} fichier(s) · {formatSize(maxSize)} max
        </p>
      </div>

      {errors.length > 0 && (
        <div className="mt-2 space-y-1">
          {errors.map((err, i) => (
            <p key={i} className="text-xs text-red-600">{err}</p>
          ))}
        </div>
      )}

      {selectedFiles.length > 0 && (
        <div className="mt-3 space-y-2">
          {selectedFiles.map((file, idx) => (
            <div
              key={idx}
              className="flex items-center gap-3 p-2.5 bg-gray-50 rounded-lg border border-gray-200"
            >
              <File className="w-4 h-4 text-gray-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-700 truncate">{file.name}</p>
                <p className="text-xs text-gray-400">{formatSize(file.size)}</p>
              </div>
              <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
              <button
                type="button"
                onClick={() => removeFile(idx)}
                className="text-gray-400 hover:text-red-500 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
