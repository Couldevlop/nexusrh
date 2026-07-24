import { useCallback, useEffect, useRef, useState } from 'react'

type SpeechRecognitionLike = {
  lang: string; interimResults: boolean; continuous: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  start: () => void; stop: () => void
}

/**
 * Web Speech API 100 % navigateur : l'audio ne quitte jamais l'appareil, seul le
 * TEXTE transcrit est utilisé. Détection de support + repli saisie clavier (le
 * composant affiche un champ texte quand `supported` est false).
 */
export function useSpeech() {
  const [speaking, setSpeaking] = useState(false)
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)

  const Recognition = (typeof window !== 'undefined'
    ? ((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition)
    : undefined) as (new () => SpeechRecognitionLike) | undefined

  const synthAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window
  const supported = Boolean(Recognition)

  const speak = useCallback((text: string, lang = 'fr-FR') => {
    if (!synthAvailable) return
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang
    u.onstart = () => setSpeaking(true)
    u.onend = () => setSpeaking(false)
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(u)
  }, [synthAvailable])

  const startListening = useCallback((lang: string, onResult: (t: string) => void) => {
    if (!Recognition) return
    const rec = new Recognition()
    rec.lang = lang; rec.interimResults = false; rec.continuous = false
    rec.onresult = (e) => { const t = e.results?.[0]?.[0]?.transcript ?? ''; onResult(t) }
    rec.onend = () => setListening(false)
    recognitionRef.current = rec
    setListening(true); rec.start()
  }, [Recognition])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop(); setListening(false)
  }, [])

  /** Coupe toute lecture vocale en cours (fermeture de modale, retour, changement de question). */
  const stopSpeaking = useCallback(() => {
    if (!synthAvailable) return
    window.speechSynthesis.cancel()
    setSpeaking(false)
  }, [synthAvailable])

  useEffect(() => () => {
    recognitionRef.current?.stop()
    if (synthAvailable) window.speechSynthesis.cancel()
  }, [synthAvailable])

  return { supported, speaking, listening, speak, startListening, stopListening, stopSpeaking }
}
