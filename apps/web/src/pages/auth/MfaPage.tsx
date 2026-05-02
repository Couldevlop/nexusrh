import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Shield, ArrowLeft, Loader2 } from 'lucide-react'
import { useLogin } from '@/hooks/useAuth'

export function MfaPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [code, setCode] = useState(['', '', '', '', '', ''])
  const [error, setError] = useState('')
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const { mutate: login, isPending } = useLogin()

  const credentials = location.state as { email: string; password: string } | null

  useEffect(() => {
    if (!credentials) {
      navigate('/login', { replace: true })
    }
  }, [credentials, navigate])

  const handleChange = (idx: number, value: string) => {
    if (!/^\d*$/.test(value)) return
    const newCode = [...code]
    newCode[idx] = value.slice(-1)
    setCode(newCode)
    if (value && idx < 5) {
      inputRefs.current[idx + 1]?.focus()
    }
  }

  const handleKeyDown = (idx: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !code[idx] && idx > 0) {
      inputRefs.current[idx - 1]?.focus()
    }
  }

  const handleSubmit = () => {
    const mfaCode = code.join('')
    if (mfaCode.length !== 6) return
    if (!credentials) return
    setError('')
    login(
      { ...credentials, mfaCode },
      {
        onError: () => setError('Code incorrect. Veuillez réessayer.'),
      }
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md"
      >
        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-indigo-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <Shield className="w-7 h-7 text-indigo-600" />
          </div>
          <h1 className="text-xl font-bold text-gray-900">Vérification en deux étapes</h1>
          <p className="text-sm text-gray-500 mt-1">
            Entrez le code à 6 chiffres de votre application d'authentification
          </p>
        </div>

        <div className="flex justify-center gap-2 mb-6">
          {code.map((digit, idx) => (
            <input
              key={idx}
              ref={(el) => { inputRefs.current[idx] = el }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={(e) => handleChange(idx, e.target.value)}
              onKeyDown={(e) => handleKeyDown(idx, e)}
              className="w-11 h-12 text-center text-lg font-bold border-2 border-gray-300 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
            />
          ))}
        </div>

        {error && (
          <p className="text-center text-sm text-red-600 mb-4">{error}</p>
        )}

        <button
          onClick={handleSubmit}
          disabled={isPending || code.some((c) => !c)}
          className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-600 text-white font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {isPending ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Vérification...</>
          ) : (
            'Confirmer'
          )}
        </button>

        <button
          onClick={() => navigate('/login')}
          className="w-full flex items-center justify-center gap-1.5 mt-3 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="w-4 h-4" />
          Retour à la connexion
        </button>
      </motion.div>
    </div>
  )
}
