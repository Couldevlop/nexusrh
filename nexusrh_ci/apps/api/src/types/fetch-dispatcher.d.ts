import type { Dispatcher } from 'undici'

/**
 * Node 20 / undici : le `fetch` global accepte l'option `dispatcher` À
 * L'EXÉCUTION, mais le type global `RequestInit` (fourni par @types/node) ne
 * l'expose pas toujours. On complète l'interface globale (fusion de
 * déclarations) pour pouvoir passer, de façon type-safe, le dispatcher épinglé
 * sur l'IP validée (anti DNS-rebinding — cf. `services/ssrf-guard.ts`).
 */
declare global {
  interface RequestInit {
    dispatcher?: Dispatcher
  }
}

export {}
