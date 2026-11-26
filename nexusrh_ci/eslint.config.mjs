/**
 * Configuration ESLint unique du monorepo (format « flat », ESLint 10).
 *
 * POURQUOI ELLE EXISTE : `pnpm run lint` était déclaré depuis le premier jour
 * mais n'avait JAMAIS pu s'exécuter — aucune configuration n'existait dans le
 * dépôt, seul `apps/web` avait ESLint installé (en 8.57, fin de vie), et aucun
 * job de CI ne l'appelait. Rien ne signalait donc la panne.
 *
 * CE QU'ELLE NE FAIT PAS : redoubler le compilateur. `tsconfig.base.json`
 * impose déjà `strict`, `noUnusedLocals`, `noUnusedParameters`,
 * `noImplicitReturns`, `noUncheckedIndexedAccess` et
 * `noFallthroughCasesInSwitch`. Deux messages pour un même défaut n'aident
 * personne : ESLint ne porte ici que ce que `tsc` ne voit pas.
 *
 * POURQUOI PAS `recommendedTypeChecked` EN BLOC : mesuré sur ce dépôt, il rend
 * 3 990 remarques, dont 3 080 de la famille « unsafe any »
 * (no-unsafe-member-access, -assignment, -return, -call, -argument). Ces
 * règles signalent une valeur de type `any` qui circule — presque toujours un
 * mock de test ou du JSON non typé. C'est de la dette de typage, pas un
 * défaut : une barrière rouge en permanence n'aurait rien gardé, elle aurait
 * seulement appris à passer `--no-verify`. Les règles retenues ci-dessous
 * désignent chacune un comportement faux à l'exécution.
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'

/** Règles portant sur un défaut d'exécution, pas sur un style. */
const REGLES_DEFAUTS = {
  // ── Règles absolues de CLAUDE.md, rendues mécaniques ──────────────────────
  // Règle 2 : « TypeScript strict — pas de `any`, pas de `@ts-ignore` ».
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/ban-ts-comment': ['error', {
    // `@ts-expect-error` reste permis AVEC justification : il échoue si
    // l'erreur disparaît, alors que `@ts-ignore` mente en silence une fois le
    // code corrigé.
    'ts-ignore': true,
    'ts-expect-error': 'allow-with-description',
    minimumDescriptionLength: 10,
  }],

  // Règle 3 : « chaque async a son try/catch ». Une promesse abandonnée
  // échappe à tout try/catch du site d'appel : le rejet devient un
  // unhandledRejection, qui en Node 20 termine le processus.
  '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
  // Une fonction async passée là où un retour `void` est attendu (un
  // gestionnaire d'évènement, un `forEach`) : personne n'attend la promesse.
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  // DESACTIVEE apres essai : son autocorrection a casse la compilation.
  // `npx eslint . --fix` a retire 157 assertions declarees inutiles ; `tsc`
  // a ensuite rendu des erreurs TS2322 et TS6133, parce que plusieurs de ces
  // assertions portaient un retrecissement de type bien reel (dans
  // payroll-validation.service.ts, `status: string` ne se reduisait plus a
  // l'union litterale attendue) et que d'autres etaient le SEUL usage d'un
  // import. ESLint et `tsc` ne voyaient donc pas le meme programme — la
  // regle a besoin des memes options de compilation que la construction pour
  // juger, et ce n'est pas le cas ici. Une regle qui se trompe en masse ne
  // peut pas etre une barriere : elle est retiree, pas contournee.
  '@typescript-eslint/no-unnecessary-type-assertion': 'off',

  // ── Fautes que le compilateur laisse passer ───────────────────────────────
  'no-unsafe-optional-chaining': 'error',
  'no-constant-binary-expression': 'error',
  'no-useless-assignment': 'error',
  'require-atomic-updates': 'error',
  'no-control-regex': 'error',
  'no-useless-escape': 'error',
  'no-irregular-whitespace': 'error',
  'prefer-const': 'error',
  '@typescript-eslint/no-unused-expressions': 'error',
  // `${objet}` rend « [object Object] » : un libellé faux sur un écran ou dans
  // un journal, jamais détecté par les types.
  '@typescript-eslint/no-base-to-string': 'error',
  '@typescript-eslint/prefer-promise-reject-errors': 'error',
  '@typescript-eslint/restrict-template-expressions': ['error', {
    allowNumber: true, allowBoolean: true, allowNullish: true,
  }],
  '@typescript-eslint/no-redundant-type-constituents': 'error',
  // Perdre la cause d'une erreur en la réemballant rend l'incident muet.
  'preserve-caught-error': 'error',

  // ── Volontairement désactivées ────────────────────────────────────────────
  // `noUnusedLocals`/`noUnusedParameters` du compilateur le font déjà, et la
  // convention du préfixe `_` est celle de tsconfig.base.json.
  '@typescript-eslint/no-unused-vars': 'off',
  // 349 occurrences : un handler Fastify déclaré `async` sans `await` est la
  // signature attendue par le framework, pas un défaut.
  '@typescript-eslint/require-await': 'off',
  // `no-console` reste desactivee : 279 appels en code de production, dont la
  // grande majorite dans les seeds et les scripts en ligne de commande, ou la
  // console EST la sortie attendue. Les cinq directives
  // `eslint-disable-next-line no-console` qui tramaient dans le code ont ete
  // retirees : elles desactivaient une regle qui n'existait pas.
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**', '**/dist/**', '**/dist-ssr/**', '**/build/**',
      '**/.turbo/**', '**/coverage/**', '**/*.d.ts', '**/public/**',
      // Fichiers de travail d'outils, hors du code du produit.
      '.remember/**', 'audit/**',
    ],
  },

  js.configs.recommended,

  // ── Code du produit : analyse AVEC les types ──────────────────────────────
  // Les règles ci-dessus ont besoin du type pour décider (une promesse
  // abandonnée ne se voit pas dans la syntaxe).
  {
    files: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: REGLES_DEFAUTS,
  },

  // ── Fichiers qu'aucun tsconfig n'inclut ───────────────────────────────────
  // Configurations de build, scripts et tests de bout en bout : le compilateur
  // ne les voyait pas DU TOUT (angle mort relevé à l'audit du 26/11/2026).
  // Ils sont analysés sans les types, donc au moins analysés.
  {
    files: [
      '*.{js,mjs,cjs}', 'apps/*/*.{ts,js,mjs,cjs}', 'packages/*/*.ts',
      'apps/*/scripts/**/*.{mjs,js}', 'apps/web/tests/**/*.ts',
    ],
    languageOptions: {
      // Le parseur TypeScript est indispensable MEME sans les types : sans
      // lui un `.ts` est lu comme du JavaScript, et la moindre annotation de
      // type devient une erreur d'analyse (drizzle.config.ts, les specs e2e).
      parser: tseslint.parser,
      globals: { ...globals.node },
    },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  // ── Front : les règles des hooks React, qu'aucun compilateur ne vérifie ───
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ── Node : api, worker, shared ────────────────────────────────────────────
  {
    files: ['apps/api/**/*.ts', 'apps/worker/**/*.ts', 'packages/shared/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
)
