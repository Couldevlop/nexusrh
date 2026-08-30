# Pré-tri des candidatures — conception

**Date** : 30 août 2026
**Périmètre** : `nexusrh_ci` — module `recruitment` (API + web)
**Statut** : conception validée sur la forme, en attente de relecture

---

## 1. Constat de départ

Le pré-tri des candidatures est **présent dans chaque couche et connecté dans aucune**.

| Élément | État réel | Preuve |
|---|---|---|
| Panneau de saisie des critères | Existe, fonctionne | `RecruitmentPage.tsx:3635` (`ScreeningCriteriaPanel`), monté ligne 643 |
| Persistance des critères | Existe | `recruitment_jobs.screening_criteria jsonb` — `provisioning.ts:1473` |
| Moteur de règles dures | Existe, pur, testé (2 fichiers de tests) | `recruitment-screening.service.ts:146` |
| **Appel du moteur** | **N'existe pas** | `evaluateScreening` n'apparaît que dans sa définition, ses tests et le `dist/` compilé |
| Colonnes de verdict | Existent, **jamais écrites** | `applications.screening_decision`, `screening_failed_rules` — seuls les `ALTER TABLE` les mentionnent |
| Endpoint `preselect` | N'écrit que les champs IA | `recruitment.routes.ts:1128-1150` — aucun `screening_*` |

Les critères saisis par le recruteur sont donc **enregistrés puis jamais lus**. Le bouton
« Pré-sélectionner » lance une analyse IA payante dont le résultat n'est confronté à aucune
règle.

Conséquence directe pour cette conception : les colonnes `screening_decision` et
`screening_failed_rules` **ne contiennent aucune donnée en production**. Elles peuvent être
redéfinies sans migration de données ni risque de perte.

### Ce qui manque, du point de vue de l'utilisateur

1. Aucun **compteur** de candidatures ou de CV reçus.
2. Aucun écran permettant de **consulter les candidats retenus par le pré-tri avant** de les
   verser au kanban.
3. Aucune **question éliminatoire** au dépôt : le formulaire public ne collecte que
   nom, e-mail, téléphone, lettre et CV (`publicApplySchema`).
4. Aucune trace distinguant un rejet **machine** d'un rejet **humain** : les deux atterrissent
   dans la même colonne `rejected`.

---

## 2. Objectif

Rendre le pré-tri **opérationnel, consultable et conforme**, sans toucher au kanban existant.

Principe directeur, repris de l'état de l'art des ATS (Greenhouse, Lever, Workable,
SmartRecruiters) : **la machine propose, l'humain dispose, tout est tracé.**

---

## 3. Périmètre

**Inclus**
- Questions éliminatoires paramétrables par offre, posées au dépôt (public et interne).
- Branchement effectif du moteur de règles dures.
- Séparation du verdict machine et de la décision humaine dans le modèle de données.
- Écran de revue en deux volets, intercalé entre le dépôt et le kanban.
- Recalcul instantané des compteurs sans appel IA.
- Dérogation (« repêchage ») avec motif obligatoire et traçabilité.

**Exclus**
- Toute refonte du kanban : il reste tel quel, il change seulement de source d'alimentation.
- L'anonymisation des CV (réduction des biais) — sujet réel mais distinct.
- Le score composite comme critère d'exclusion — écarté par conception, voir §8.
- L'ajustement automatique des seuils — écarté par conception, voir §8.

---

## 4. Flux cible

```
   DÉPÔT                ÉVALUATION              REVUE                  PIPELINE
┌─────────────┐      ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│ CV          │      │ Questions    │      │ Écran deux   │      │ Kanban       │
│ + réponses  │─────▶│ (déterministe)│─────▶│ volets       │─────▶│ (inchangé)   │
│   aux       │      │ + règles dures│      │ Retenir /    │      │              │
│ questions   │      │   sur le CV   │      │ Écarter /    │      │ n'accueille  │
│ éliminatoires│     │              │      │ Repêcher     │      │ que du décidé│
└─────────────┘      └──────────────┘      └──────────────┘      └──────────────┘
                     verdict MACHINE       décision HUMAINE
                     pass | flagged        kept | dismissed
```

**Règle d'or** : aucune candidature n'entre dans le kanban tant que
`screening_decision IS NULL`. Un verdict `flagged` n'est pas un rejet — c'est une
proposition de rejet.

L'évaluation se fait en **deux temps indépendants** :

1. **Les questions éliminatoires** sont évaluées immédiatement au dépôt. Déterministe,
   instantané, **sans aucun appel IA**. C'est le filtre principal.
2. **Les règles dures sur le CV** ne s'appliquent qu'aux candidatures dont le CV a été
   analysé par l'IA (via `preselect` ou `analyze-cv`). Elles complètent le filtre, elles ne
   le portent pas.

Cette séparation est délibérée : elle rend le pré-tri utile **avant** toute dépense d'IA, et
fait reposer les exclusions sur des données déclarées par le candidat plutôt qu'inférées.

---

## 5. Modèle de données

### 5.1 `recruitment_jobs` — définition des questions

Nouvelle colonne, ajoutée dans `ensureRecruitmentSchemaMigrated` (`provisioning.ts`) :

```sql
ALTER TABLE {schema}.recruitment_jobs
  ADD COLUMN IF NOT EXISTS screening_questions jsonb DEFAULT '[]'
```

Forme d'une question :

```ts
interface ScreeningQuestion {
  id:       string          // uuid, stable — sert de clé dans les réponses
  label:    string          // « Êtes-vous titulaire du permis B ? »  (max 300)
  type:     'boolean' | 'number' | 'choice'
  options?: string[]        // type 'choice' uniquement, 2 à 20 entrées
  required: boolean         // réponse obligatoire au dépôt
  knockout: boolean         // false = informatif, n'exclut jamais
  rule?: {                  // requis si knockout, ignoré sinon
    | { op: 'is';    value: boolean }        // type boolean
    | { op: 'min';   value: number  }        // type number
    | { op: 'max';   value: number  }        // type number
    | { op: 'in';    value: string[] }       // type choice
  }
}
```

Trois types seulement, délibérément. Ils couvrent l'essentiel des questions éliminatoires
réelles (oui/non, seuil numérique, liste fermée) ; en ajouter davantage complexifierait la
saisie sans gain démontré.

### 5.2 `applications` — réponses, verdict, décision

Une instruction par appel `q()`, conformément au style du fichier :

```sql
ALTER TABLE {schema}.applications ADD COLUMN IF NOT EXISTS screening_answers      jsonb DEFAULT '{}';
ALTER TABLE {schema}.applications ADD COLUMN IF NOT EXISTS screening_verdict      varchar(10);
ALTER TABLE {schema}.applications ADD COLUMN IF NOT EXISTS screening_evaluated_at timestamptz;
ALTER TABLE {schema}.applications ADD COLUMN IF NOT EXISTS screening_decided_by   uuid;
ALTER TABLE {schema}.applications ADD COLUMN IF NOT EXISTS screening_decided_at   timestamptz;
ALTER TABLE {schema}.applications ADD COLUMN IF NOT EXISTS screening_reason       text;
-- screening_decision      (existe, VIERGE) → redéfini : 'kept' | 'dismissed' | NULL
-- screening_failed_rules  (existe, VIERGE) → conservé tel quel
```

`screening_answers` est un objet `{ [questionId]: boolean | number | string }`.

**Redéfinition de `screening_decision`.** La colonne portait le verdict machine
(`auto_reject` | `review`) dans l'intention d'origine, mais **aucune ligne n'a jamais été
écrite**. Elle devient donc la décision humaine sans conversion ni perte. Le verdict machine
migre vers `screening_verdict`, qui est une colonne neuve.

### 5.3 Rétrocompatibilité — le point à ne pas rater

Les candidatures existantes ont `screening_decision IS NULL`. Sans précaution, la règle d'or
du §4 les ferait **toutes disparaître du kanban** au déploiement.

**Contrainte à ne pas sous-estimer.** `ensureRecruitmentSchemaMigrated` n'est **pas
mémoïsée** : elle rejoue l'intégralité de ses instructions à chaque appel, et le dépôt ne
possède aucune table de suivi des migrations. Un rattrapage écrit naïvement
(`UPDATE … WHERE screening_decision IS NULL`) se rejouerait donc à chaque requête et
**approuverait automatiquement tous les candidats en attente de revue** — détruisant
précisément la garantie du §4. Le rattrapage doit être **structurellement** non rejouable,
pas seulement « exécuté une fois ».

Séquence retenue, en trois temps :

```sql
-- 1. Colonne nullable : seules les lignes ANTÉRIEURES auront NULL.
ALTER TABLE {schema}.applications ADD COLUMN IF NOT EXISTS screening_verdict varchar(10);

-- 2. Rattrapage. Une ligne sans verdict est nécessairement antérieure à cette migration.
UPDATE {schema}.applications
   SET screening_decision = COALESCE(screening_decision, 'kept'),
       screening_verdict  = 'pass',
       screening_reason   = COALESCE(screening_reason,
         'Antériorité : candidature reçue avant la mise en place du pré-tri')
 WHERE screening_verdict IS NULL;

-- 3. Le verdict devient obligatoire → plus aucune ligne ne peut avoir NULL.
ALTER TABLE {schema}.applications ALTER COLUMN screening_verdict SET DEFAULT 'pass';
ALTER TABLE {schema}.applications ALTER COLUMN screening_verdict SET NOT NULL;
```

Après l'étape 3, **aucune ligne de la table ne peut plus satisfaire la condition de
l'étape 2**. Le rattrapage est donc idempotent par construction, quel que soit le nombre
d'exécutions — sans mémoïsation ni table de suivi.

Le `DEFAULT 'pass'` joue un second rôle : si un chemin d'insertion oubliait de poser le
verdict, la candidature serait marquée conforme et **partirait tout de même en file de
revue** (`screening_decision` restant `NULL`). L'oubli est donc permissif et visible, jamais
silencieusement décidé. Le `NOT NULL` rend l'état ambigu impossible.

Deux tests golden verrouillent l'ensemble : une candidature antérieure reste visible dans le
kanban, et rejouer la migration dix fois ne modifie aucune décision en attente.

---

## 6. API

Toutes les routes s'ajoutent au module `recruitment` existant, sous le préfixe `/recruitment`
déjà déclaré dans la carte `PREFIX` de `ui-api-contract.golden.test.ts` — aucun ajout requis
de ce côté.

### 6.1 Définition des questions (RH)

| Méthode | Route | Rôles | Objet |
|---|---|---|---|
| `GET` | `/jobs/:id/screening-questions` | admin, hr_manager, hr_officer | Lire la définition |
| `PUT` | `/jobs/:id/screening-questions` | admin, hr_manager | Écrire la définition |

Validation Zod stricte : au plus 15 questions, `label` ≤ 300 caractères, cohérence
`type` ↔ `rule` (une règle `min` sur un `boolean` est refusée), `knockout: true` impose une
`rule`.

### 6.2 Évaluation

| Méthode | Route | Rôles | Objet |
|---|---|---|---|
| `POST` | `/jobs/:id/screening/preview` | admin, hr_manager, hr_officer | **Simulation.** Reçoit les critères et questions *en cours d'édition* (non encore enregistrés), les applique aux candidatures de l'offre, renvoie les compteurs. **N'écrit rien.** |
| `POST` | `/jobs/:id/screening/apply` | admin, hr_manager | Évalue et **persiste** les verdicts des candidatures non encore décidées |

`preview` est le cœur du recalcul instantané : les règles étant pures, il n'y a ni appel IA
ni écriture. Le volet gauche de l'écran l'appelle à chaque modification de critère (avec un
anti-rebond), et affiche « 23 conformes / 8 signalés » en direct.

Réponse commune :

```ts
{ data: { total: number, pass: number, flagged: number, pending: number,
          byRule: Array<{ rule: string, count: number }> } }
```

`byRule` indique quel critère écarte le plus de monde — l'information la plus utile pour
régler un pré-tri, et absente aujourd'hui.

### 6.3 File de revue et décision

| Méthode | Route | Rôles | Objet |
|---|---|---|---|
| `GET` | `/jobs/:id/screening/queue` | admin, hr_manager, hr_officer | File paginée des candidatures non décidées |
| `PATCH` | `/applications/:id/screening-decision` | admin, hr_manager, hr_officer | `{ decision: 'kept' \| 'dismissed', reason?: string }` |

La file renvoie, par candidature : identité, `screening_verdict`, `screening_failed_rules`,
`screening_answers` mises en regard des libellés de questions, `has_cv`, et le résumé IA s'il
existe. Tri par défaut : signalés en dernier (on traite d'abord les dossiers conformes).

**Motif obligatoire en cas de dérogation.** Si `decision = 'kept'` alors que
`screening_verdict = 'flagged'`, `reason` devient requis (≥ 10 caractères). Symétriquement,
écarter un candidat `pass` exige aussi un motif. Dans les deux cas, l'humain contredit la
machine : c'est précisément ce qui doit être justifié et tracé.

Effets de la décision :
- `kept` → `stage = 'screening'` (le candidat entre dans le kanban)
- `dismissed` → `stage = 'rejected'`
- dans les deux cas : `screening_decided_by`, `screening_decided_at`, `screening_reason`
  renseignés, et une entrée `auditTenant` avec l'action `recruitment.screening_decided`,
  portant le verdict machine, la décision humaine et le motif.

### 6.4 Dépôt public — questions et réponses

- `GET /recruitment/public/:tenantSlug/jobs/:jobId` : ajoute `screeningQuestions` à la
  réponse — **sans les règles**. Le candidat voit les questions, jamais les seuils.
- `POST /recruitment/public/:tenantSlug/jobs/:jobId/apply` : `publicApplySchema` accepte un
  champ `answers` (objet). Les questions `required` manquantes → `400` avec le détail par
  champ, cohérent avec la gestion d'erreur existante.

L'évaluation des questions est faite **dans le handler de dépôt**, immédiatement : la
candidature est écrite avec son `screening_verdict` déjà calculé.

---

## 7. Moteur d'évaluation

### 7.1 Extension du service existant

`recruitment-screening.service.ts` reçoit une seconde fonction pure, à côté de
`evaluateScreening` :

```ts
export function evaluateQuestions(
  questions: ScreeningQuestion[],
  answers:   Record<string, unknown>,
): { failedRules: string[] }
```

Mêmes principes que l'existant, et pour les mêmes raisons :
- une réponse **manquante** ne provoque jamais d'exclusion — elle laisse passer en revue ;
- chaque règle échouée produit un libellé **en français, lisible par un humain**
  (« Permis B exigé », « 5 ans d'expérience minimum, 3 déclarées ») ;
- aucune I/O, aucune dépendance : testable en isolation.

### 7.2 Combinaison des deux verdicts

```ts
export function combineVerdicts(
  questionResult: { failedRules: string[] },
  cvResult:       ScreeningVerdict | null,   // null si CV non analysé
): { verdict: 'pass' | 'flagged'; failedRules: string[] }
```

`flagged` si l'un des deux échoue. `failedRules` concatène les deux listes. Le CV non analysé
n'empêche pas l'évaluation : les questions suffisent à trancher, ce qui est le point.

### 7.3 Où le brancher

- **Dépôt** (public et interne) : `evaluateQuestions` puis écriture du verdict.
- **`preselect` / `analyze-cv`** : après l'analyse IA, appeler `evaluateScreening` avec les
  critères de l'offre, recombiner, mettre à jour `screening_verdict` et
  `screening_failed_rules`. **C'est le branchement manquant identifié au §1.**
- **`screening/apply`** : réévalue en lot les candidatures non décidées.

---

## 8. Ce qui est écarté, et pourquoi

**Le score composite comme critère d'exclusion.** « Vous obtenez 62/100 » est indéfendable
face à un candidat ; « le poste exige le permis B » se justifie en une phrase. Le score IA
reste calculé et affiché, et sert à **ordonner** la file de revue — jamais à en exclure
quelqu'un. Le seuil `autoRejectBelowScore` existant est conservé pour compatibilité mais
n'est plus proposé par défaut dans l'interface.

**L'ajustement automatique des seuils.** `decisions-history` existe déjà et apprend des
choix du recruteur. Cette matière reste une **suggestion explicite** — « vos 12 dernières
décisions suggèrent d'abaisser le seuil à 3 ans, appliquer ? » — jamais un ajustement
silencieux. Un critère qui bouge sans trace rend l'égalité de traitement indémontrable.

**Des critères variant par candidat.** Ce qui s'adapte, c'est la possibilité de **déroger avec
motif**, pas le critère lui-même. Des seuils qui changent silencieusement d'un dossier à
l'autre sont exactement ce que le droit de la non-discrimination cherche à empêcher.

---

## 9. Conformité

| Exigence | Traduction dans la conception |
|---|---|
| **RGPD art. 22** — pas de décision individuelle purement automatisée | Aucun rejet sans `screening_decision` posée par un humain identifié. Le verdict machine est une proposition. |
| **RGPD art. 13** — information sur la logique du traitement | Mention sur le formulaire de dépôt : les réponses servent à un premier tri automatique, une personne examine chaque dossier avant toute décision. |
| **AI Act (UE 2024/1689)** — recrutement classé haut risque, contrôle humain (art. 14), journalisation | Contrôle humain structurel (règle d'or) ; journalisation via `auditTenant` de chaque décision avec verdict, décision, motif et auteur. |
| **Loi ivoirienne sur les données personnelles / ARTCI** | L'architecture ci-dessus satisfait le standard le plus strict. **La liste exacte des obligations locales reste à faire confirmer par le conseil juridique d'OpenLab** — ce document ne s'y substitue pas. |
| **Non-discrimination à l'embauche** | Avertissement explicite dans l'interface de saisie des questions : ne pas fonder de critère sur l'âge, le sexe, l'origine, la situation de famille, l'état de santé, les convictions religieuses ou l'appartenance syndicale. **Pas de blocage automatique** : une détection par mots-clés serait peu fiable et donnerait une fausse assurance. La responsabilité reste au recruteur, l'outil l'informe et trace. |

---

## 10. Interface — écran de revue

Nouvel onglet `screening` dans `RecruitmentPage.tsx`, entre `jobs` et `pipeline`, avec le
compteur de dossiers en attente en pastille.

**Volet gauche — critères et compteurs**
Réutilise `ScreeningCriteriaPanel` (déplacé depuis l'onglet pipeline), complété par l'éditeur
de questions éliminatoires et un bandeau de compteurs vivants alimenté par
`screening/preview` avec anti-rebond. La liste `byRule` montre quel critère écarte le plus.

**Volet droit — file de revue**
Un dossier à la fois. Identité, réponses aux questions en regard des libellés, règles en vert
et en rouge, CV inline (`cv-file`, mécanisme blob existant), résumé IA s'il existe.
Trois actions : Retenir, Écarter, Repêcher. Navigation clavier (`J`/`K` pour se déplacer,
`Entrée` pour retenir, `X` pour écarter). Le champ motif apparaît et devient obligatoire dès
que la décision contredit le verdict machine.

**Kanban** : inchangé, alimenté par `screening_decision = 'kept'`.

Extraction de composants : `RecruitmentPage.tsx` fait déjà 3 814 lignes. Le nouvel onglet est
écrit dans un fichier séparé `pages/recruitment/ScreeningReview.tsx`, et
`ScreeningCriteriaPanel` y est déplacé. On n'agrandit pas un fichier déjà trop gros.

---

## 11. Intégration à l'existant — points de vigilance

Relevés depuis l'audit du 29-30/08 et l'historique du dépôt :

1. **Migration lazy** : ajouter les colonnes dans `ensureRecruitmentSchemaMigrated`
   (`provisioning.ts`), jamais dans le seed. Le seed ne s'exécute pas en production.
2. **Piste d'audit** : utiliser `auditTenant` (`utils/audit-log.ts`), jamais une requête
   `INSERT INTO … audit_log` en direct — l'invariant golden `architecture-invariants` le
   refuse.
3. **Erreurs 400** : utiliser `badRequest` / `badRequestFromZod` (`utils/http-errors.ts`).
4. **Contrat UI ↔ API** : le préfixe `/recruitment` est déjà déclaré ; aucune modification de
   la carte `PREFIX` n'est nécessaire.
5. **Balayage d'autorisation** : les deux nouvelles routes publiques n'en sont pas —
   `screeningQuestions` s'ajoute à un endpoint public **existant**. Aucune entrée à ajouter
   dans `PUBLIC_ROUTES` de `security-authz-sweep.golden.test.ts`.
6. **i18n** : compléter `fr/recruitment.json` **et** `en/recruitment.json`. Le golden i18n
   échoue si une clé manque d'un côté.
7. **Fichiers nouveaux** : `git add -f` obligatoire, le `.gitignore` racine masque
   `nexusrh_ci/`.
8. **Repository** : introduire `modules/recruitment/screening.repository.ts`, qui reçoit le
   schéma à la construction et expose des méthodes typées. C'est la première application de
   la direction recommandée en A-05 de l'audit — sur du code neuf, sans réécriture de
   l'existant.

---

## 12. Tests

**Unitaires (moteur pur)**
- `evaluateQuestions` : chaque type, chaque opérateur, réponse manquante → jamais d'exclusion,
  question `knockout: false` → jamais d'exclusion.
- `combineVerdicts` : `pass`+`pass`→`pass` ; l'un `flagged`→`flagged` ; CV absent → seules les
  questions comptent.

**Golden — `screening-pipeline.golden.test.ts`**
Le parcours complet via `app.inject` : définition des questions → dépôt public avec réponses
→ verdict calculé → apparition dans la file → décision → entrée dans le kanban.

Trois invariants verrouillés :
1. **Aucune candidature `screening_decision IS NULL` n'apparaît dans le kanban.** C'est la
   traduction testable de l'article 22.
2. **Une dérogation sans motif est refusée en 400.**
3. **Les règles ne sont jamais exposées au public** : `GET /public/…/jobs/:jobId` renvoie les
   libellés des questions, jamais les seuils.

**Golden de rétrocompatibilité** — `screening-backfill.golden.test.ts`
1. Une candidature antérieure à la migration reste visible dans le kanban après déploiement.
2. **Rejouer la migration dix fois ne modifie aucune décision en attente** — le rattrapage
   n'est pas rejouable, ce qui est la propriété de sécurité la plus importante de ce lot.

**Web** : test de composant sur `ScreeningReview` — le champ motif devient obligatoire quand
la décision contredit le verdict.

---

## 13. Risques

| Risque | Traitement |
|---|---|
| Les candidatures existantes disparaissent du kanban | Rattrapage §5.3 + golden dédié. |
| **Le rattrapage se rejoue et approuve les dossiers en attente** | **Risque principal, traité §5.3** : le rattrapage est rendu non rejouable *par construction* (`NOT NULL` posé à la fin), pas par mémoïsation — laquelle n'existe pas sur `ensureRecruitmentSchemaMigrated`. Golden dédié : dix exécutions ne modifient aucune décision en attente. |
| Un recruteur pose une question discriminatoire | Avertissement en interface, traçabilité complète. Pas de blocage automatique — assumé et justifié §9. |
| Le pré-tri écarte trop largement | `byRule` montre quel critère coupe ; `preview` permet de le régler sans coût ; rien n'est définitif avant décision humaine. |
| `RecruitmentPage.tsx` grossit encore | Nouvel onglet dans un fichier séparé, panneau de critères déplacé. Le fichier existant diminue. |

---

## 14. Séquencement proposé

1. Modèle de données + migration de rattrapage + goldens de rétrocompatibilité.
2. Moteur : `evaluateQuestions`, `combineVerdicts`, et **branchement de `evaluateScreening`**
   dans `preselect` / `analyze-cv` — le correctif du constat §1.
3. API : questions, `preview`, `apply`, `queue`, `screening-decision`.
4. Dépôt public : questions exposées, réponses acceptées et évaluées.
5. Interface : `ScreeningReview.tsx`, déplacement du panneau de critères, i18n FR + EN.
6. Goldens de bout en bout.

Chaque étape est livrable et testable seule. L'étape 2 apporte déjà de la valeur sans aucune
interface nouvelle : le pré-tri se met à fonctionner.
