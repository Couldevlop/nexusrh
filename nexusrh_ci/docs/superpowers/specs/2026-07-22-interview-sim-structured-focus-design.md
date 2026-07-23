# Simulations d'entretien — Profil technique structuré (Phase 1/3) — Design

> Spec de cadrage. Décisions prises avec l'utilisateur le 2026-07-22.
> Étend le module `interview_sim` déjà livré, cadré dans
> `2026-07-21-simulations-entretien-design.md` (à lire en premier pour le contexte
> général : publics, banque partagée, RGPD, API existante).
>
> **Ce document couvre uniquement le Phase 1 : modèle de données + saisie.**
> Deux phases suivantes, hors périmètre ici, feront chacune l'objet d'une spec séparée :
> - **Phase 2** — génération structurée des questions (répartition par catégorie,
>   pondération par priorité/séniorité) consommant les données du Phase 1.
> - **Phase 3** — refonte visuelle de l'écran de restitution (skill design), avec
>   probable score par catégorie plutôt que la liste plate actuelle.

## 1. Contexte & problème

Aujourd'hui, la génération des questions (`interview-sim-ai.service.ts`,
`genererQuestions`) n'utilise que `title` + `secteur` du poste — même les champs
`description`/`requirements` de l'offre, pourtant existants, ne sont pas transmis.
Résultat : des questions génériques, jamais calées sur les exigences réelles d'un
poste (langages de programmation précis, années d'expérience attendues par
technologie, outils, méthodologie de travail, niveaux de langue).

L'utilisateur veut que la simulation reflète les VRAIES caractéristiques du poste,
telles que saisies à la rédaction de l'offre (ou du profil de poste de l'employé
pour le self-service) : ex. pour un poste de développeur senior, les questions
doivent porter sur les langages/frameworks réellement exigés (Java, Spring, Spring
Boot, Hibernate, Spring Security, ORM, SQL, Docker…), sur les outils, sur la
méthodologie (Scrum/Agile/SAFe), pondérés selon la priorité et la séniorité.

Le Phase 1 pose le socle : **capturer et stocker** ces caractéristiques
structurées. Il ne change **aucun** comportement de génération (Phase 2).

## 2. Décisions structurantes (validées avec l'utilisateur)

| Sujet | Décision |
|---|---|
| Emplacement de la donnée | Nouveau champ **`interview_focus` (jsonb, nullable)**, dupliqué sur `recruitment_jobs` **et** sur `employees` — pas de réutilisation de `screening_criteria` (isolation, zéro risque de régression sur le pré-tri de CV existant) |
| Portée | Les deux flux existants bénéficient de la donnée quand elle est renseignée : self-service salarié (source = `employees.interview_focus`) et candidat public (source = `recruitment_jobs.interview_focus`) |
| Repli | Champ **entièrement optionnel**. Offre/employé sans `interview_focus` → comportement générique actuel inchangé (le Phase 2 gère le repli) |
| Ordre = priorité | Le tableau `technologies` est ordonné **du plus prioritaire au moins prioritaire** — pas de champ de priorité séparé |
| Séniorité | Réutilise `recruitment_jobs.experience_level` (déjà existant, façon APEC : `debutant_accepte` / `min_1_an` / `1_3_ans` / `3_7_ans` / `min_7_ans`) pour calibrer la profondeur des questions (Phase 2). **Aucun équivalent côté `employees`** — le self-service reste à profondeur standard, non calibrée |
| Niveau de langue parlée | Liste fermée **CECRL (A1→C2)**, affichée à l'écran avec un libellé français à côté (ex. "B2 — Courant") — structuré pour l'algorithme, lisible pour le recruteur |
| Qui saisit | `admin` / `hr_manager` uniquement, sur le formulaire offre (création/édition) et sur la fiche employé (édition) — jamais en self-service salarié |
| Journalisation | Chaque écriture de `interview_focus` génère une entrée `audit_log` (action nommée pour matcher `categorizeAction()` du module Sécurité/SIEM existant → catégorie `config`), en vue d'une exploitation future par un projet externe (SIEM/cyberdéfense) via l'export SIEM déjà en place (`security.service.ts`, webhook HMAC JSON/CEF) |

## 3. Modèle de données

### Type partagé (nouveau fichier ou ajout à `interview-sim-bank.service.ts` / module dédié)

```ts
export const CECRL_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
export type CecrlLevel = (typeof CECRL_LEVELS)[number]

export interface InterviewFocusTechnology {
  name: string           // ex: "Java" — libre, 1-80 caractères
  yearsRequired: number  // 0-40
}

export interface InterviewFocusLanguage {
  language: string       // ex: "Anglais" — libre, 1-40 caractères
  level: CecrlLevel
}

export interface InterviewFocus {
  technologies:  InterviewFocusTechnology[]  // ordre = priorité, max 15
  tools:         string[]                    // max 15, chaque item 1-60 caractères
  methodologies: string[]                    // max 10, chaque item 1-60 caractères
  languages:     InterviewFocusLanguage[]    // max 6
}
```

### Colonnes

- `ALTER TABLE <schema>.recruitment_jobs ADD COLUMN IF NOT EXISTS interview_focus jsonb`
- `ALTER TABLE <schema>.employees ADD COLUMN IF NOT EXISTS interview_focus jsonb`

Ajoutées dans `db/provisioning.ts` (nouveau schéma) **et** dans la section migration
lazy (schémas existants), même patron que les colonnes `recruitment_jobs`
existantes (`visibility`, `public_slug`, `screening_criteria`, etc.) déjà en place
dans ce fichier.

### Validation (zod, `.strict()`)

```ts
const interviewFocusSchema = z.object({
  technologies: z.array(z.object({
    name: z.string().min(1).max(80),
    yearsRequired: z.number().int().min(0).max(40),
  })).max(15),
  tools: z.array(z.string().min(1).max(60)).max(15),
  methodologies: z.array(z.string().min(1).max(60)).max(10),
  languages: z.array(z.object({
    language: z.string().min(1).max(40),
    level: z.enum(CECRL_LEVELS),
  })).max(6),
}).strict().optional()
```

Réutilisée dans le schéma de création/édition d'offre (`recruitment.routes.ts`) et
dans celui de création/édition d'employé (`employees.routes.ts` ou équivalent).

## 4. Saisie (UI)

- **Formulaire offre** (`admin`/`hr_manager`, création + édition) — nouvelle section
  repliable "Profil technique de l'entretien" (i18n FR/EN, namespace `interviewSim`
  ou `recruitment` selon convention existante) :
  - Liste de technologies : ajout/suppression dynamique, champs nom + années
    d'expérience, réordonnable (glisser-déposer ou boutons haut/bas) pour piloter
    la priorité.
  - Outils : saisie en tags (chips).
  - Méthodologies : cases à cocher pour les valeurs courantes (Scrum, Agile, SAFe,
    Kanban, Waterfall) + champ libre pour une valeur non listée.
  - Langues : sélection langue (libre) + niveau CECRL (select, libellé FR affiché).
  - Section entièrement optionnelle et repliée par défaut — n'alourdit pas le
    formulaire pour les postes qui n'en ont pas besoin (ex. Chauffeur Bus Senior).
- **Fiche employé** (`admin`/`hr_manager`, édition) — même section, sur l'onglet
  fiche de poste existant. Pas de saisie self-service.

## 5. Journalisation (audit / futur SIEM)

- `recruitment.job.interview_focus_updated` — sur update d'une offre où
  `interview_focus` change (diff avant/après dans `changes` jsonb, `user_id`,
  `entity_id` = job id, `ip_address`).
- `employees.interview_focus_updated` — même patron sur la fiche employé.
- Écriture `audit_log` **non bloquante** (`.catch()`), même patron que
  `recruitment.source_profiles` déjà en place. Ces noms d'action correspondent au
  pattern déjà reconnu par `categorizeAction()` (`security.service.ts`, contient
  `updated` → catégorie `config`) : automatiquement exportables au SIEM existant
  dès qu'un tenant active la catégorie `config`. Aucune nouvelle plomberie de log à
  construire — seulement une alimentation cohérente de `audit_log`.

## 6. Erreurs & robustesse

- Payload invalide → 400 (zod), jamais de 500 brute (cohérent avec le handler
  d'erreurs global du module).
- Migration `ADD COLUMN IF NOT EXISTS` idempotente — aucun risque d'échec sur
  schéma déjà à jour.
- `interview_focus` absent/`NULL` → traité comme "non renseigné" partout en aval
  (Phase 2). Aucune régression sur les offres/employés existants.

## 7. Tests (TDD)

- **Migration** : golden test vérifiant la présence de la colonne `interview_focus`
  sur `recruitment_jobs` et `employees` après migration d'un schéma existant (même
  patron que `interview-sim.tenant-migration.test.ts` /
  `interview-sim.platform-migration.test.ts` déjà en place).
- **Validation zod** : technologie sans nom, années hors bornes (négatif, >40),
  niveau CECRL invalide, listes dépassant les bornes de taille → 400 dans les deux
  formulaires (offre, employé).
- **Persistance** : `interview_focus` correctement transmis/stocké/relu sur
  création ET édition, sans effet de bord sur les autres champs (`screening_criteria`
  notamment — doit rester intact).
- **Audit** : entrée `audit_log` créée avec la bonne action/diff sur mutation,
  absence d'échec de la requête si l'écriture d'audit échoue.
- **Non-régression** : suite `interview-sim` (203 tests), golden `ui-api-contract`,
  golden `tenant-modules` doivent rester verts — ce Phase 1 ne touche ni au flux de
  génération ni au routing des modules.

## 8. Hors périmètre (rappel)

- Aucun changement à `genererQuestions`/`produireRetour` (Phase 2).
- Aucun changement à l'écran de restitution (Phase 3).
- Le bug sourcing IA (candidats internes remontés sur une offre externe) est un
  sujet **distinct**, tracké séparément — investigation prévue après ce Phase 1
  (via `audit_log` de l'action `recruitment.source_profiles` pour identifier
  précisément l'offre ciblée par le test utilisateur).
