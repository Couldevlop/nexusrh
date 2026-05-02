// Ambient module declarations for packages without .d.ts files
declare module 'fastify-plugin/plugin.js' {
  import fp from 'fastify-plugin'
  export default fp
  export = fp
}

declare module 'bullmq' {
  export class Queue {
    constructor(name: string, opts?: { connection: unknown })
    add(name: string, data: unknown): Promise<{ id: string | undefined }>
  }
  export class Worker {
    constructor(name: string, processor: (job: unknown) => Promise<unknown>, opts?: { connection: unknown })
  }
}

declare module 'ioredis' {
  export default class IORedis {
    constructor(url: string, opts?: Record<string, unknown>)
    quit(): Promise<void>
  }
}
