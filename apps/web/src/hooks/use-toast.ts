import * as React from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

type ToastVariant = 'default' | 'destructive' | 'success' | 'warning'

export interface ToastProps {
  id: string
  title?: string
  description?: string
  variant?: ToastVariant
  duration?: number
}

type ToastInput = Omit<ToastProps, 'id'>

interface ToastState {
  toasts: ToastProps[]
}

type Action =
  | { type: 'ADD'; toast: ToastProps }
  | { type: 'REMOVE'; id: string }
  | { type: 'UPDATE'; toast: Partial<ToastProps> & { id: string } }

// ── State machine ────────────────────────────────────────────────────────────

const TOAST_LIMIT = 5
const TOAST_REMOVE_DELAY = 4000

let count = 0
function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  return count.toString()
}

const listeners: Array<(state: ToastState) => void> = []
let memoryState: ToastState = { toasts: [] }

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action)
  listeners.forEach((listener) => listener(memoryState))
}

function reducer(state: ToastState, action: Action): ToastState {
  switch (action.type) {
    case 'ADD':
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      }
    case 'REMOVE':
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.id),
      }
    case 'UPDATE':
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

function toast(input: ToastInput) {
  const id = genId()
  const duration = input.duration ?? TOAST_REMOVE_DELAY

  dispatch({ type: 'ADD', toast: { ...input, id } })

  setTimeout(() => {
    dispatch({ type: 'REMOVE', id })
  }, duration)

  return {
    id,
    dismiss: () => dispatch({ type: 'REMOVE', id }),
    update: (props: ToastInput) => dispatch({ type: 'UPDATE', toast: { ...props, id } }),
  }
}

function useToast() {
  const [state, setState] = React.useState<ToastState>(memoryState)

  React.useEffect(() => {
    listeners.push(setState)
    return () => {
      const index = listeners.indexOf(setState)
      if (index > -1) listeners.splice(index, 1)
    }
  }, [])

  return {
    toasts: state.toasts,
    toast,
    dismiss: (id: string) => dispatch({ type: 'REMOVE', id }),
  }
}

export { useToast, toast }
