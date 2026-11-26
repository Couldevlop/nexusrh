import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV:     z.enum(['development', 'production', 'test']).default('development'),
  APP_NAME:     z.string().default('NexusRH'),
  APP_URL:      z.string().default('http://localhost:3001'),
  API_URL:      z.string().default('http://localhost:4001'),
  API_PORT:     z.coerce.number().default(4001),
  LOG_LEVEL:    z.string().default('info'),
  LOCALE:       z.string().default('fr-CI'),
  CURRENCY:     z.string().default('XOF'),
  TIMEZONE:     z.string().default('Africa/Abidjan'),

  DATABASE_URL:       z.string(),
  DATABASE_POOL_MIN:  z.coerce.number().default(2),
  DATABASE_POOL_MAX:  z.coerce.number().default(10),

  REDIS_URL: z.string().default('redis://localhost:6380'),

  ENCRYPTION_KEY:        z.string().length(64, 'ENCRYPTION_KEY doit être 64 caractères hex (32 bytes)').optional(),
  // Clé PRÉCÉDENTE, le temps d'une rotation : déchiffre l'existant, ne chiffre
  // jamais (cf. packages/shared/src/crypto.ts).
  ENCRYPTION_KEY_PREVIOUS: z.string().length(64, 'ENCRYPTION_KEY_PREVIOUS doit être 64 caractères hex (32 bytes)').optional(),
  JWT_SECRET:            z.string().min(32),
  // Swagger /docs : exposé uniquement hors production, sauf override explicite.
  ENABLE_DOCS:           z.string().transform(v => v === 'true').prefault('false'),
  /**
   * OWASP A07 — nombre de proxys de confiance DEVANT l'API, ou liste de CIDR.
   *
   * `trustProxy: true` (ancienne valeur) signifie « faire confiance à TOUS les
   * intermédiaires » : `request.ip` devient alors l'entrée la plus à gauche de
   * `X-Forwarded-For`, entièrement contrôlée par le client. Le limiteur de débit
   * comptant par `request.ip`, un attaquant remettait son compteur à zéro à
   * chaque requête en faisant tourner l'en-tête — neutralisant les protections
   * anti-force-brute du login et du mot de passe oublié.
   *
   * Défaut `loopback, uniquelocal` : seules les adresses PRIVÉES (l'ingress, qui
   * vit dans le CIDR de pods du cluster) sont des intermédiaires de confiance.
   * Deux propriétés en découlent :
   *   - derrière l'ingress, l'IP retenue est celle qu'il a constatée, et toute
   *     entrée injectée par le client reste hors de la fenêtre de confiance ;
   *   - en exposition directe, une connexion venue d'Internet est publique donc
   *     NON digne de confiance : son `X-Forwarded-For` est ignoré en bloc et
   *     l'IP réelle de la socket est utilisée.
   *
   * Un simple nombre de sauts (`1`) n'offre PAS la seconde propriété : le saut
   * de confiance serait consommé par l'attaquant lui-même. Fastify 5 tire la
   * même conclusion et fait ÉCHOUER-FERMÉ tout `trustProxy` numérique (« hop
   * count only trust cannot validate the immediate peer »). On n'accepte donc
   * que des plages : noms proxy-addr (`loopback`, `linklocal`, `uniquelocal`),
   * adresses ou CIDR, séparés par des virgules. Pour un CDN devant l'ingress,
   * ajouter ses plages ici.
   */
  TRUST_PROXY:           z.string().default('loopback, uniquelocal'),

  /**
   * OWASP A08 — analyse antivirale des fichiers deposes (clamd).
   * CLAMAV_HOST absent = analyse desactivee (defaut dev/test, comportement
   * historique inchange). Renseigne = tout depot est analyse, et un fichier
   * qui n'a PAS pu etre analyse est refuse (echec ferme).
   */
  CLAMAV_HOST:       z.string().optional(),
  CLAMAV_PORT:       z.coerce.number().default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().default(15_000),
  JWT_EXPIRES_IN:        z.string().default('7d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  MFA_ISSUER:            z.string().default('NexusRH'),

  GOOGLE_CLIENT_ID:     z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL:  z.string().default('http://localhost:4001/auth/google/callback'),

  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL:          z.string().default('claude-sonnet-4-20250514'),
  AI_MAX_TOKENS:     z.coerce.number().default(4096),
  AI_TEMPERATURE:    z.coerce.number().default(0.3),
  // Fournisseur IA par défaut au niveau plateforme (repli quand un tenant n'a
  // pas de réglage propre). 'claude' (Anthropic) ou 'mistral'. Paramétrable.
  AI_DEFAULT_PROVIDER: z.enum(['claude', 'mistral']).default('claude'),

  // Mistral (option alternative pour scoring CV — au choix dans l'UI)
  MISTRAL_API_KEY:   z.string().optional(),
  MISTRAL_MODEL:     z.string().default('mistral-large-latest'),
  MISTRAL_API_URL:   z.string().default('https://api.mistral.ai/v1'),

  // Modèle LOCAL (dernier recours du chat IA) : une API OpenAI-compatible
  // hébergée par l'exploitant — vLLM, Ollama, llama.cpp… Sans URL, rien ne
  // change ; avec une URL, le chat répond au lieu de renvoyer 503 quand aucune
  // clé Claude ni Mistral n'est disponible. La clé est FACULTATIVE : un service
  // interne au cluster n'en demande pas (certaines passerelles exigent un
  // jeton factice, d'où l'option).
  AI_LOCAL_API_URL: z.string().default(''),
  AI_LOCAL_MODEL:   z.string().default('mistral-7b-instruct'),
  AI_LOCAL_API_KEY: z.string().optional(),
  /**
   * Hôtes INTERNES autorisés comme adresse de modèle, séparés par des virgules
   * (`hote` ou `hote:port`). OWASP A10.
   *
   * L'adresse du modèle est réglable en base depuis l'écran super_admin, puis
   * appelée par le pod — qui tourne DANS le cluster. Sans cette liste, l'écran
   * de paramètres devenait un scanner du réseau interne : `169.254.169.254`,
   * `postgres.<ns>.svc`, n'importe quel service, avec la réponse renvoyée en
   * flux à l'appelant. Un hôte PUBLIC reste validé par la garde SSRF commune ;
   * un hôte interne doit figurer ici, c'est-à-dire avoir été déclaré par
   * l'exploitant au déploiement et non choisi depuis l'interface.
   */
  AI_LOCAL_ALLOWED_HOSTS: z.string().default(''),

  // Sceau des exports de piste d'audit (HMAC-SHA256). Sans clé, l'export reste
  // produit mais le manifeste indique `sealed: false` : un export qui se
  // présenterait comme scellé sans l'être vaudrait moins que pas de sceau.
  // Jamais de valeur par défaut : un secret partagé publiquement ne scelle rien.
  AUDIT_SIGNING_KEY: z.string().optional(),

  SMTP_HOST:   z.string().default('smtp.gmail.com'),
  SMTP_PORT:   z.coerce.number().default(587),
  SMTP_SECURE: z.string().transform(v => v === 'true').prefault('false'),
  SMTP_USER:   z.string().default(''),
  SMTP_PASS:   z.string().default(''),
  SMTP_FROM:   z.string().default('NexusRH <noreply@nexusrh-ci.com>'),

  S3_ENDPOINT:         z.string().default('http://localhost:9002'),
  S3_ACCESS_KEY:       z.string().default('minioadmin'),
  S3_SECRET_KEY:       z.string().default('minioadmin'),
  S3_BUCKET:           z.string().default('nexusrhci'),
  S3_REGION:           z.string().default('af-west-1'),
  S3_FORCE_PATH_STYLE: z.string().transform(v => v === 'true').prefault('true'),

  MEILISEARCH_URL:        z.string().default('http://localhost:7701'),
  MEILISEARCH_MASTER_KEY: z.string().default('nexusrhci-dev-master-key'),

  WAVE_API_KEY:        z.string().optional(),
  WAVE_API_URL:        z.string().default('https://api.wave.com/v1'),
  WAVE_WEBHOOK_SECRET: z.string().optional(),

  MTN_MOMO_API_KEY:          z.string().optional(),
  MTN_MOMO_API_URL:          z.string().default('https://sandbox.momodeveloper.mtn.com'),
  MTN_MOMO_SUBSCRIPTION_KEY: z.string().optional(),
  MTN_MOMO_ENV:              z.string().default('sandbox'),
  MTN_MOMO_WEBHOOK_SECRET:   z.string().optional(),

  ORANGE_MONEY_API_KEY:       z.string().optional(),
  ORANGE_MONEY_API_URL:       z.string().default('https://api.orange.com/orange-money-webpay/ci/v1'),
  ORANGE_MONEY_MERCHANT_KEY:  z.string().optional(),
  ORANGE_MONEY_WEBHOOK_SECRET: z.string().optional(),

  FEATURE_AI_ASSISTANT:     z.string().transform(v => v === 'true').prefault('true'),
  FEATURE_MOBILE_MONEY:     z.string().transform(v => v === 'true').prefault('true'),
  FEATURE_CNPS_AUTO_EXPORT: z.string().transform(v => v === 'true').prefault('true'),
  FEATURE_DISA_GENERATOR:   z.string().transform(v => v === 'true').prefault('true'),
  FEATURE_FDFP_MODULE:      z.string().transform(v => v === 'true').prefault('true'),
  FEATURE_OHADA_CONTRACTS:  z.string().transform(v => v === 'true').prefault('true'),
  FEATURE_OFFLINE_PWA:      z.string().transform(v => v === 'true').prefault('true'),
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('Variables d\'environnement invalides:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

const env = parsed.data

// ── Durcissement secrets (OWASP A02/A05) ──────────────────────────────────────
// Une valeur d'exemple/faible PRÉSENTE est refusée au boot (secret prévisible →
// JWT forgeable, ou clé de chiffrement triviale → NNI/IBAN réversibles).
// Une ENCRYPTION_KEY ABSENTE est désormais FATALE en production (voir plus bas) :
// une API qui démarre sans pouvoir chiffrer NNI et IBAN ment sur son état.
const EXAMPLE_JWT_SECRET = 'nexusrh-ci-super-secret-key-minimum-32-chars!!'
/** true si une clé PRÉSENTE est faible (n'évalue pas l'absence — voir ci-dessous). */
function isWeakEncryptionKey(key: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(key)) return true   // pas 64 hex
  if (/^0+$/.test(key)) return true                  // tout à zéro (exemple)
  if (new Set(key.toLowerCase()).size <= 2) return true // entropie quasi nulle
  return false
}
if (env.NODE_ENV === 'production') {
  const fatal: string[] = []
  if (env.JWT_SECRET === EXAMPLE_JWT_SECRET) {
    fatal.push('JWT_SECRET : la valeur d\'exemple est interdite en production (générer ≥ 256 bits aléatoires).')
  }
  // Seule LA valeur d'exemple était refusée : une clé courte, répétitive ou
  // devinable passait. Or une clé de signature publiée ou devinée permet de
  // forger un jeton `super_admin` sur n'importe quel tenant SANS se connecter —
  // MFA, expiration des mots de passe, verrouillage et grille d'habilitations
  // se trouvent tous APRÈS la vérification de signature. C'est arrivé : la clé
  // de production a séjourné six mois dans un dépôt public (constat du
  // 26/11/2026). Deux garde-fous simples, qu'une clé aléatoire franchit sans y
  // penser et qu'un mot de passe choisi à la main échoue.
  if (env.JWT_SECRET.length < 48) {
    fatal.push(`JWT_SECRET : ${env.JWT_SECRET.length} caractères, 48 minimum en production — openssl rand -hex 48.`)
  }
  if (new Set(env.JWT_SECRET).size < 16) {
    fatal.push('JWT_SECRET : trop peu de caractères distincts pour une clé aléatoire (16 minimum).')
  }
  if (env.ENCRYPTION_KEY && isWeakEncryptionKey(env.ENCRYPTION_KEY)) {
    fatal.push('ENCRYPTION_KEY présente mais faible : 64 caractères hex aléatoires requis (pas la valeur d\'exemple tout-à-zéro).')
  }
  // DÉSORMAIS FATAL, et c'est un renversement assumé : le commit 31d53b2 avait
  // rendu l'absence tolérable pour débloquer un déploiement. Le résultat a été
  // une API qui démarre en annonçant qu'elle fonctionne, alors que toute
  // création d'employé portant un NNI ou un IBAN rend un 500 — exactement
  // l'incident constaté. Une clé qui protège des numéros d'identification
  // nationale et des IBAN ne se devine pas à l'exécution : ou elle est là, ou
  // l'API refuse de servir.
  if (!env.ENCRYPTION_KEY) {
    fatal.push('ENCRYPTION_KEY absente : obligatoire en production (NNI/IBAN, secrets TOTP, mots de passe SMTP des tenants) — openssl rand -hex 32.')
  }
  if (env.ENCRYPTION_KEY_PREVIOUS) {
    if (isWeakEncryptionKey(env.ENCRYPTION_KEY_PREVIOUS)) {
      fatal.push('ENCRYPTION_KEY_PREVIOUS présente mais faible : 64 caractères hex attendus.')
    }
    if (env.ENCRYPTION_KEY_PREVIOUS === env.ENCRYPTION_KEY) {
      // Sinon la « rotation » ne rote rien et personne ne s'en aperçoit : les
      // deux clés étant identiques, tout continue de fonctionner.
      fatal.push('ENCRYPTION_KEY_PREVIOUS identique à ENCRYPTION_KEY : la rotation ne change rien, retirer la clé précédente.')
    }
  }
  if (!env.CLAMAV_HOST) {
    // Le code d'analyse antivirale est correct et échoue fermé une fois
    // configuré — mais il n'était configuré nulle part. Constaté le
    // 26/11/2026 : aucune variable CLAMAV ni aucun déploiement clamd dans le
    // namespace de production. Or l'un des points de dépôt est PUBLIC (CV
    // envoyé depuis une offre d'emploi, sans authentification) : tout fichier
    // y est stocké sans être analysé. Avertissement et non refus, parce que
    // bloquer le démarrage de l'API couperait le service pour un composant
    // qui n'a jamais tourné — mais l'absence cesse d'être silencieuse.
    console.warn('[config] ⚠ CLAMAV_HOST absente en production — les fichiers déposés (CV publics, documents RH, pièces de frais) ne sont PAS analysés. Déployer clamd et renseigner CLAMAV_HOST.')
  }
  if (fatal.length > 0) {
    console.error('Configuration de production refusée (secrets non sûrs) :')
    for (const m of fatal) console.error('  - ' + m)
    process.exit(1)
  }
}

export const config = {
  env:      env.NODE_ENV,
  appName:  env.APP_NAME,
  appUrl:   env.APP_URL,
  apiUrl:   env.API_URL,
  port:     env.API_PORT,
  logLevel: env.LOG_LEVEL,
  locale:   env.LOCALE,
  currency: env.CURRENCY,
  timezone: env.TIMEZONE,
  // Swagger /docs : activé hors prod, ou via ENABLE_DOCS=true en prod (protégé).
  enableDocs: env.ENABLE_DOCS || env.NODE_ENV !== 'production',

  /** Liste de plages de confiance passée à l'option Fastify `trustProxy`
   *  (cf. TRUST_PROXY). Toujours une chaîne : un nombre serait interprété par
   *  Fastify 5 comme « ne faire confiance à personne ». */
  trustProxy: env.TRUST_PROXY,

  /** Analyse antivirale des depots de fichiers (cf. services/antivirus.service.ts). */
  antivirus: {
    host:      env.CLAMAV_HOST ?? null,
    port:      env.CLAMAV_PORT,
    timeoutMs: env.CLAMAV_TIMEOUT_MS,
    /** Taille des blocs INSTREAM ; sous la limite clamd StreamMaxLength. */
    chunkSize: 64 * 1024,
  },

  database: {
    url:     env.DATABASE_URL,
    poolMin: env.DATABASE_POOL_MIN,
    poolMax: env.DATABASE_POOL_MAX,
  },

  redis: { url: env.REDIS_URL },

  jwt: {
    secret:         env.JWT_SECRET,
    expiresIn:      env.JWT_EXPIRES_IN,
    refreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
    mfaIssuer:      env.MFA_ISSUER,
  },

  google: {
    clientId:     env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackUrl:  env.GOOGLE_CALLBACK_URL,
  },

  ai: {
    apiKey:          env.ANTHROPIC_API_KEY,
    model:           env.AI_MODEL,
    maxTokens:       env.AI_MAX_TOKENS,
    temperature:     env.AI_TEMPERATURE,
    defaultProvider: env.AI_DEFAULT_PROVIDER,
  },

  mistral: {
    apiKey: env.MISTRAL_API_KEY,
    model:  env.MISTRAL_MODEL,
    apiUrl: env.MISTRAL_API_URL,
  },

  /** Scellement des exports d'audit : `null` = exports non scellés. */
  audit: {
    signingKey: env.AUDIT_SIGNING_KEY ?? null,
  },

  /** Modèle local (dernier recours) : `apiUrl` vide = non configuré. */
  aiLocal: {
    apiUrl: env.AI_LOCAL_API_URL,
    model:  env.AI_LOCAL_MODEL,
    apiKey: env.AI_LOCAL_API_KEY ?? null,
    /**
     * Hôtes internes déclarés par l'exploitant (cf. AI_LOCAL_ALLOWED_HOSTS).
     * L'hôte d'`AI_LOCAL_API_URL` y est joint d'office : l'avoir écrit dans
     * l'environnement EST une déclaration d'exploitant.
     */
    allowedHosts: [
      ...env.AI_LOCAL_ALLOWED_HOSTS.split(',').map(h => h.trim().toLowerCase()).filter(Boolean),
      ...(() => {
        try { return [new URL(env.AI_LOCAL_API_URL).host.toLowerCase()] } catch { return [] }
      })(),
    ],
  },

  smtp: {
    host:   env.SMTP_HOST,
    port:   env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user:   env.SMTP_USER,
    pass:   env.SMTP_PASS,
    from:   env.SMTP_FROM,
  },

  s3: {
    endpoint:       env.S3_ENDPOINT,
    accessKey:      env.S3_ACCESS_KEY,
    secretKey:      env.S3_SECRET_KEY,
    bucket:         env.S3_BUCKET,
    region:         env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  },

  meilisearch: {
    url:       env.MEILISEARCH_URL,
    masterKey: env.MEILISEARCH_MASTER_KEY,
  },

  mobileMoney: {
    wave: {
      apiKey:        env.WAVE_API_KEY,
      apiUrl:        env.WAVE_API_URL,
      webhookSecret: env.WAVE_WEBHOOK_SECRET,
    },
    mtn: {
      apiKey:          env.MTN_MOMO_API_KEY,
      apiUrl:          env.MTN_MOMO_API_URL,
      subscriptionKey: env.MTN_MOMO_SUBSCRIPTION_KEY,
      env:             env.MTN_MOMO_ENV,
      webhookSecret:   env.MTN_MOMO_WEBHOOK_SECRET,
    },
    orange: {
      apiKey:        env.ORANGE_MONEY_API_KEY,
      apiUrl:        env.ORANGE_MONEY_API_URL,
      merchantKey:   env.ORANGE_MONEY_MERCHANT_KEY,
      webhookSecret: env.ORANGE_MONEY_WEBHOOK_SECRET,
    },
  },

  features: {
    aiAssistant:    env.FEATURE_AI_ASSISTANT,
    mobileMoney:    env.FEATURE_MOBILE_MONEY,
    cnpsAutoExport: env.FEATURE_CNPS_AUTO_EXPORT,
    disaGenerator:  env.FEATURE_DISA_GENERATOR,
    fdfpModule:     env.FEATURE_FDFP_MODULE,
    ohadaContracts: env.FEATURE_OHADA_CONTRACTS,
    offlinePwa:     env.FEATURE_OFFLINE_PWA,
  },
} as const
