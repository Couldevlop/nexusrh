# Simulations d'entretien — Design

> Spec de cadrage. Décisions prises avec l'utilisateur le 2026-07-21.
> Module NexusRH CI. Cette spec **remplace** le cadrage antérieur généré sans
> validation utilisateur (`2026-07-21-simulation-entretien-vocal-design.md`,
> conservé hors branche pour mémoire) : le périmètre ci-dessous est différent
> (entraînement **privé**, banque de questions **partagée**, aucune restitution RH).

## 1. Objectif & périmètre

Un module activable par tenant, **`interview_sim`** (« Simulations d'entretien »),
permettant à une personne de **s'entraîner en autonomie** à un entretien, avec un
retour immédiat. **Deux publics** :

- **Candidat externe** — depuis une offre de recrutement publiée (page carrières),
  bouton « S'entraîner à l'entretien » ; les questions collent au poste de l'offre.
- **Salarié interne** — depuis son espace self-service (carrière / mobilité), déjà
  authentifié ; s'entraîne pour son poste ou un poste de mobilité visé.

**Finalité = entraînement privé.** Aucune restitution RH/manager, **aucun écran
manager, aucun RBAC de restitution, aucun tableau de scores.** Le retour n'est vu
que par la personne qui s'entraîne.

### Hors périmètre (premier jet)
- Voix côté serveur (STT/TTS) ou agent temps réel « speech-to-speech ».
- Entretien **adaptatif** (relances générées selon les réponses) — on livre du
  séquentiel ; l'adaptatif pourra venir plus tard.
- Outil recruteur RH (entretien réel assisté / compte-rendu).
- Restitution des résultats à un tiers (manager, recruteur).

## 2. Décisions structurantes (validées)

| Sujet | Décision |
|---|---|
| Publics | Externe (recrutement, via offre) **et** interne (self-service) |
| Modalité | **Texte** en socle **+ voix** en option |
| Voix | **100 % navigateur** (Web Speech API) ; l'audio ne quitte jamais l'appareil, seul le **texte transcrit** est utilisé ; **repli saisie texte** si le navigateur ne supporte pas la reconnaissance vocale |
| Finalité | Entraînement **privé** — pas de restitution RH |
| Déroulé | **Séquentiel** : N questions posées l'une après l'autre, retour en fin |
| Intelligence | Réutilise l'abstraction IA existante (`resolveAiCreds` → claude \| mistral, repli plateforme) |
| Banque de questions | **Globale/partagée `platform`**, accessible à **tous les tenants sans restriction**, clé par **métier normalisé** — persiste, sert de **repli** hors IA, et **s'enrichit** au fil du temps |
| Rétention (différenciée) | **Externe : éphémère** (consentement RGPD + aucune donnée personnelle conservée) · **Interne : historique personnel** privé |

## 3. Architecture

Trois couches à responsabilité unique :

- **Voix (navigateur)** — Web Speech API : `SpeechSynthesis` lit la question,
  `SpeechRecognition` capte la réponse et la transcrit **sur l'appareil**. Détection
  de support ; **repli saisie clavier** si indisponible (Safari/Firefox limités).
  Aucun audio n'est transmis ni stocké.
- **Intelligence** — `interview-sim-ai.service.ts`, deux fonctions pures :
  - `genererQuestions(contextePoste, banquePassee, creds)` → N questions.
  - `produireRetour(questions, transcrits, contextePoste, creds)` → retour structuré
    (points forts, axes de progrès, réponses repères). Sortie JSON stricte.
  - **Repli gracieux** : si l'IA est injoignable/non abonnée, aucune erreur brute —
    on sert la banque (questions) et, pour le retour, un message « analyse
    indisponible, réessayez » (jamais de 500 ; cohérent avec le handler global).
- **Données** — voir §4.

Câblage module selon le patron établi : clé module API + web, golden
`ui-api-contract`, i18n FR/EN, `enabled_modules`, provisioning + migration paresseuse
(`ensureTenantSchema`).

## 4. Modèle de données

### `platform.interview_sim_question_banks` — mémoire partagée du système
- Global, **partagé par tous les tenants sans restriction** (même patron que le
  référentiel légal `droit-ci`).
- Clé par **métier normalisé** (intitulé de poste normalisé + secteur), **pas** par
  tenant, **pas** par entreprise.
- Colonnes : `id`, `role_key` (métier normalisé), `secteur`, `langue`,
  `questions jsonb` (jeu généré), `source_model`, `created_at`.
- **Trois rôles** : (a) **repli** — dernier jeu servi si IA absente ; (b)
  **nourrissage** — à chaque génération pour un poste connu, les questions passées
  sont injectées au prompt (« varie, ne répète pas, améliore »), et le nouveau jeu
  enrichit la banque ; (c) **réutilisation** — deux candidats sur le même métier
  partagent le socle.
- **Garde-fou anti-fuite** : on ne persiste que des **questions génériques**
  réutilisables ; aucune spécificité identifiante d'un tenant/entreprise (détail
  confidentiel d'une description de poste) n'est stockée. La normalisation du
  `role_key` et la consigne de génération excluent les éléments propres à
  l'entreprise. **Aucune donnée personnelle.**

### `<tenant>.interview_sim_attempts` — historique privé (INTERNE uniquement)
- Cloisonné au schéma du tenant. Lié à `employee_id`.
- Colonnes : `id`, `employee_id`, `role_key` (poste visé), `langue`,
  `questions jsonb`, `answers jsonb` (`[{index, question, transcript}]`),
  `retour jsonb` (points forts, axes, réponses repères), `created_at`.
- **Visible du seul salarié.** Isolation tenant stricte intégrale.

### Externe — aucune table de données personnelles
- Le candidat consomme la banque + reçoit son retour à l'écran ; **rien de personnel
  conservé**. Au plus un **compteur d'usage anonyme et agrégé** (par métier), sans
  identité ni transcript.

## 5. Flux

### Génération / nourrissage des questions (pour un métier)
1. IA disponible → génération **en injectant les questions passées** de la banque
   (variation/amélioration) → le résultat **enrichit** la banque.
2. IA injoignable/non abonnée → **repli** sur le dernier jeu stocké pour ce métier.
3. Banque vide **et** IA absente → message clair « génération indisponible »
   (jamais d'erreur brute).

### Candidat externe (public, depuis une offre)
Consentement RGPD + autorisation micro → boucle séquentielle : question affichée
(et lue à voix haute si voix activée) → réponse orale transcrite **ou** au clavier →
question suivante → **retour affiché** → **tout est jeté** (rien de personnel conservé).

### Salarié interne (self-service, authentifié)
Même déroulé → à la fin, tentative **enregistrée dans l'historique privé** ; écran
« Mes simulations » avec la progression dans le temps ; suppression possible par le
salarié.

## 6. API

**Interne, authentifié (RBAC + Zod)**
- `GET /interview-sim/start` — contexte poste + questions (banque partagée ou
  génération), langue.
- `POST /interview-sim/attempts/submit` — transcrits → retour + **enregistrement
  historique privé**.
- `GET /interview-sim/my-attempts` + `/:id` — historique du salarié (le sien seul).
- `DELETE /interview-sim/my-attempts/:id` — **droit à l'effacement** de ses données.

**Externe, public à jeton** (durci comme l'upload CV public : rate-limit IP, jeton à
forte entropie, expiration)
- `GET /public/interview-sim/:token` — poste + questions + **texte de consentement**.
- `POST /public/interview-sim/:token/submit` — transcrits → **retour éphémère**,
  rien de personnel stocké (au plus incrément d'un compteur anonyme).

La lecture/écriture de la **banque partagée** est faite **côté serveur** dans ces
routes — pas de CRUD tenant-facing. Préfixes `/interview-sim` et
`/public/interview-sim` déclarés au golden `ui-api-contract`.

## 7. Écrans (web, i18n FR/EN)

- **Interne** : « Mes simulations » (self-service) — choisir une cible (poste actuel
  ou poste de mobilité), passer l'entretien (voix + repli texte), voir le retour,
  historique + suppression.
- **Externe** : page d'entretien **publique** (sans habillage applicatif), atteinte
  par un bouton **« S'entraîner à l'entretien »** sur l'offre / la page carrières →
  consentement + micro → entretien → écran de retour. Rien conservé.
- **Voix** : Web Speech API ; détection de support ; **repli saisie texte** automatique.

## 8. Sécurité (OWASP) & RGPD

**Sécurité**
- **A01/A03** : RBAC + Zod stricts ; module gaté `enabled_modules['interview_sim']` ;
  l'interne ne voit **que** ses propres tentatives (scoping `employee_id` dérivé du
  **JWT**, jamais du body/query).
- **A04** : bornes anti-token-burn sur génération + retour ; rate-limits par tenant ;
  jeton public à forte entropie + expiration + rate-limit IP.
- **Anti prompt-injection** : le transcript (réponse candidat) est une **donnée non
  fiable**, sanitisée, jamais autorisée à écraser le prompt système.
- **Isolation** : historique interne strictement cloisonné au tenant ; la banque
  partagée ne contient que des questions génériques (garde-fou §4).

**RGPD**
- **Externe** : consentement **horodaté** avant de démarrer, session **éphémère**,
  **aucune donnée personnelle** conservée (au plus compteur anonyme agrégé).
- **Interne** : historique personnel **effaçable par le salarié** (`DELETE
  /my-attempts/:id`) et purgé à la suppression du compte.

## 9. Paramétrage tenant
Toggle module `interview_sim`. Réglages : langue par défaut, nombre de questions par
simulation, expiration par défaut des jetons publics, texte de consentement
personnalisable.

## 10. Tests (TDD, viser ~98 % de couverture)
- **Service IA** (LLM mocké) : forme des questions/retour ; **repli banque quand IA
  absente** ; **nourrissage** (injection des questions passées au prompt).
- **Routes** : RBAC par rôle ; jeton public (nominal / expiré / rate-limit) ; Zod ;
  **isolation/IDOR** (un interne ne lit jamais les tentatives d'un autre) ; **éphémère
  externe** (aucune écriture de donnée personnelle).
- **Golden** `ui-api-contract` (préfixes) ; provisioning/migration (banque `platform`
  + table tenant ; **mocker `schema-migrations`** — piège connu).

## 11. Démo (seed)
Amorcer `platform.interview_sim_question_banks` avec 2–3 métiers courants (ex.
« Chauffeur », « Comptable », « Agent d'exploitation ») pour que la banque ne soit
pas vide au premier lancement, même hors IA.
