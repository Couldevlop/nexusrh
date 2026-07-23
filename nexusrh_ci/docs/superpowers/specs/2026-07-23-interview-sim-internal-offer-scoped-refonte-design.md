# Simulations d'entretien — Entretien interne offre-scopé + restitution redesignée — Design

> Spec de cadrage. Décisions prises avec l'utilisateur le 2026-07-23.
> Fait suite au module `interview_sim` (`2026-07-21-simulations-entretien-design.md`)
> et au profil technique structuré `interview_focus`
> (`2026-07-22-interview-sim-structured-focus-design.md`), déjà livrés et déployés.

## 1. Contexte & problème

Le module `interview_sim` propose aujourd'hui, côté interne, une page **self-service
générique** (`/mon-espace/simulations`, entrée de sidebar `nav.interviewSim`) :
le salarié lance une simulation calibrée sur **son propre poste** (`employees.job_title`
+ `employees.interview_focus`), via `GET /interview-sim/start`, et consulte un
historique privé (`interview_sim_attempts`).

L'utilisateur veut supprimer cette approche par **menu générique** au profit d'un
entraînement **lié à une offre interne précise**, exactement comme le flux public :
sur la page carrières publique, chaque offre porte un bouton « s'entraîner à
l'entretien » qui ouvre une simulation calibrée sur `recruitment_jobs.interview_focus`
+ `experience_level` de cette offre. En interne, la page `MesOffresInternes`
(`/mon-espace/offres`) liste déjà les offres internes ; c'est là que le bouton doit
vivre.

Second grief : le design de l'écran de **restitution** (score, scores par catégorie,
forces/axes, réponses repères) reste au rendu générique. L'utilisateur exige une
refonte esthétique réelle, menée avec le **skill frontend-design**.

## 2. Décisions structurantes (validées avec l'utilisateur)

| Sujet | Décision |
|---|---|
| Menu self-service générique | **Supprimé entièrement** : entrée sidebar + route `/mon-espace/simulations` + page `MesSimulations.tsx` (+ test). L'entretien ne se lance QUE depuis une offre interne. |
| Source de calibrage | L'**offre interne** (`recruitment_jobs`) : `interview_focus` + `experience_level`, comme le flux public. Plus jamais le poste de l'employé. |
| Lancement | **En place** dans la fiche offre (modale de détail de `MesOffresInternes`) : bascule vers l'entretien puis la restitution, sans nouvel onglet, sans quitter la page. Retour = revient au détail de l'offre. |
| Rétention | **Éphémère, comme l'externe** : restitution affichée sur place, **rien de personnel stocké** (au plus le compteur anonyme agrégé `platform.interview_sim_usage`). Évite des données `interview_sim_attempts` sans UI pour les consulter/effacer (piège RGPD). |
| Authentification | Routes **authentifiées** (salarié connecté) — pas de jeton éphémère (réservé au candidat externe anonyme). Scoping tenant via `schemaName` du JWT, jamais du body/params (OWASP A01/A03). |
| Restitution | Refonte visuelle de `InterviewRestitution` via **frontend-design**. Composant **partagé** → l'externe (`PublicInterviewSimPage`) en bénéficie automatiquement. |

## 3. Architecture

### 3.1 Backend — routes internes offre-scopées (miroir authentifié du public)

Deux nouvelles routes dans `interview-sim.routes.ts`, bloc INTERNE authentifié,
calibrées sur l'**offre** (`jobId` en paramètre de path) :

- `GET /interview-sim/internal-jobs/:jobId/start`
  - `preHandler: [fastify.authenticate, migrateSchemaOfAuthenticatedUser]`
  - Vérifie que l'offre existe, appartient au tenant (schéma du JWT) **et** est
    **interne-visible** (même filtre que `GET /recruitment/internal-jobs`, cf.
    `recruitment.routes.ts`) — sinon `404` (jamais fuiter l'existence d'une offre
    non interne). OWASP A01 : `jobId` sert au lookup dans le schéma du tenant,
    jamais à traverser les tenants.
  - Construit `PosteContext` depuis `recruitment_jobs` : `title`, `secteur`
    (via `platform.tenants.sector`), `langue` (config tenant), `interviewFocus`
    (`parseInterviewFocus`), `experienceLevel`.
  - Génère questions + catégories via `genererQuestions` (service Phase 2, banque
    partagée + repli). Renvoie `{ data: { jobId, jobTitle, langue, roleKey,
    nbQuestions, questions, categories } }`.
- `POST /interview-sim/internal-jobs/:jobId/submit`
  - Mêmes preHandlers. Valide le body (`questions`, `categories?`, `answers`) via
    un schéma Zod strict (réutilise `transcriptItemSchema`).
  - Produit le retour via `produireRetour` (contexte = offre) et le renvoie
    `{ data: { retour } }`. **Éphémère** : rien écrit dans `interview_sim_attempts`.
    Au plus `incrementUsage(normalizeRoleKey(title, secteur), langue)` (compteur
    anonyme agrégé, comme le public).

### 3.2 Backend — suppression des routes génériques employé-scopées

Deviennent inutiles et sont **retirées** de `interview-sim.routes.ts` :
`GET /interview-sim/start`, `POST /interview-sim/attempts/submit`,
`GET /interview-sim/my-attempts`, `GET /interview-sim/my-attempts/:id`,
`DELETE /interview-sim/my-attempts/:id`.

Conservés intacts : `GET/PUT /interview-sim/config` (réglages tenant) et **tout le
bloc public** (`interviewSimPublicRoutes`).

La table `interview_sim_attempts` reste en place (inerte) — aucune migration
supprimée, zéro risque sur les tenants existants. Le `mintPublicInterviewToken` et
le flux public sont inchangés.

### 3.3 Frontend — bouton + entretien en place dans `MesOffresInternes`

`MesOffresInternes.tsx` gère déjà une modale de détail d'offre (`selected`). On y
ajoute un état de **mode** local : `'detail' | 'interview' | 'result'`.

- **detail** (existant) : méta APEC + description + formulaire de candidature. On
  ajoute un bouton **« S'entraîner à l'entretien »** à côté de « Postuler ».
- **interview** : au clic, `GET /interview-sim/internal-jobs/:id/start` charge les
  questions ; la modale affiche le déroulé (question courante, badge catégorie,
  barre de progression, `useSpeech` voix + repli `textarea`) — logique reprise de
  l'actuel `MesSimulations` mais **sans historique**.
- **result** : à la dernière réponse, `POST .../submit` renvoie le retour ; la
  modale affiche `<InterviewRestitution feedback={...} />`. Un bouton « Retour à
  l'offre » ramène en mode `detail` ; « Recommencer » relance `start`.

L'entretien vit **dans la même modale authentifiée** — pas de route dédiée, pas de
nouvel onglet. Fermer la modale abandonne la session (rien n'était stocké).

Retraits : entrée sidebar `nav.interviewSim` (`EmployeeLayout.tsx`), route
`/mon-espace/simulations` (`App.tsx`), page `MesSimulations.tsx` + `MesSimulations.test.tsx`.

### 3.4 Frontend — refonte de la restitution (skill frontend-design)

`InterviewRestitution.tsx` (composant partagé interne + public) est retravaillé avec
le **skill frontend-design** : direction visuelle intentionnelle pour la jauge de
score global, les scores par catégorie, le bloc forces/axes et les réponses repères.
Contraintes : rester **thème-aware** (variables Tailwind du design system existant :
`bg-card`, `text-muted-foreground`, `border-border`, couleur `primary` du tenant),
accessible (contrastes, `aria-label` sur la jauge SVG déjà présent), responsive.
L'API du composant (`InterviewFeedback`) ne change pas → `PublicInterviewSimPage` et
la nouvelle vue interne consomment le même rendu.

## 4. Sécurité / conformité

- **A01/A03 (IDOR/injection)** : `jobId` résolu dans le schéma du tenant (JWT),
  filtre interne-visible obligatoire, `404` neutre si hors périmètre. `roleKey`
  normalisé serveur avant tout `incrementUsage` (anti-pollution du compteur global
  partagé).
- **RGPD** : flux interne éphémère → aucune donnée personnelle d'entretien stockée,
  cohérent avec l'externe. Pas de `interview_sim_attempts` orphelins sans UI.
- **Rate-limit** : `start` (20/min) et `submit` (10/min), comme les routes existantes.
- **Non-régression** : bloc public et config tenant inchangés ; champ `interview_focus`
  toujours optionnel (repli générique si offre non renseignée).

## 5. Tests

**API** (`interview-sim.routes.internal.test.ts` remanié) :
- `GET /internal-jobs/:jobId/start` : `401` sans token ; `404` offre inexistante ;
  `404` offre non interne-visible ; `200` + questions/catégories calibrées sur
  l'`interview_focus` de l'offre.
- `POST /internal-jobs/:jobId/submit` : `401` ; `400` body invalide ; `200` + retour ;
  **assert qu'aucun `INSERT interview_sim_attempts` n'est émis** (éphémère).
- Retrait des tests des routes supprimées (`start`, `attempts/submit`, `my-attempts*`).
- Mise à jour du golden `interview-sim.ui-contract.golden.test.ts` et de
  `ui-api-contract.golden` (nouveaux chemins, retrait des anciens).

**Web** :
- `MesOffresInternes.test.tsx` : présence du bouton « S'entraîner à l'entretien » ;
  clic → `start` appelé ; bascule en mode entretien ; soumission → `InterviewRestitution`
  rendu ; « Retour à l'offre » revient au détail.
- Retrait de `MesSimulations.test.tsx`.
- `PublicInterviewSimPage.test.tsx` : reste vert (composant `InterviewRestitution`
  partagé, API inchangée).
- Parité i18n : les libellés du **déroulé et de la restitution** réutilisent le
  namespace **`interviewSim`** existant (clés `questionProgress`, `speakButton`,
  `finishButton`, `feedbackTitle`, etc., déjà présentes). Les **nouveaux** libellés
  propres à l'offre (bouton « S'entraîner à l'entretien », « Retour à l'offre ») sont
  ajoutés au namespace **`monEspace`** (section `offers`), consommé par
  `MesOffresInternes`. FR/EN à parité (test de parité existant `interview-sim-i18n`).

## 6. Hors périmètre (YAGNI)

- Pas de page d'historique interne, pas de stockage d'essai interne.
- Pas de calibrage sur la séniorité du salarié (on prend celle de l'offre).
- Pas de refonte du déroulé public (`PublicInterviewSimPage`) au-delà du composant
  partagé de restitution.
- Pas de suppression de la table `interview_sim_attempts` ni de sa migration.
