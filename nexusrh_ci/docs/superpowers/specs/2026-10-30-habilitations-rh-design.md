# Habilitations RH par groupes — design

_30/10/2026 — décidé avec le porteur produit, brainstorming du 30/10._

## 1. Intention

Aujourd'hui, un utilisateur NexusRH porte **un seul rôle** (`users.role` :
admin, hr_manager, hr_officer, manager, raf…), contrôlé par
`fastify.authorize(...roles)` avec des listes plates. Le cloisonnement par
filiale n'existe que dans le workflow de paie multi-filiales. Il n'y a ni
table de groupes ni table de permissions.

Ce modèle ne colle pas à une vraie équipe RH de groupe : un RH de filiale
ne doit **jamais** voir une autre filiale, un membre du siège ne voit toutes
les filiales que si on le lui accorde **personnellement**, et une chargée de
recrutement ne doit pas voir les salaires.

On veut des **groupes et sous-groupes d'habilitation paramétrables par chaque
tenant**, où l'on habilite une personne via une **fiche d'habilitation**
validée par sa hiérarchie, puis appliquée par l'admin du tenant d'un clic.
« Tout doit être fluide et transparent », et le workflow est **100 %
pilotable depuis l'admin du tenant**.

Les membres de l'équipe RH restent des **employés** : ils ont leur propre
dossier employé, et leurs habilitations ne leur donnent jamais de droit
particulier sur leur propre dossier (voir §5.4).

## 2. Objectifs

- Arborescence **Groupe → sous-groupes**, paramétrable par tenant (pas de
  structure figée SOTRA). Exemple type : `DRH Groupe` → `RH Siège`,
  `RH Filiale <nom>` (un par filiale).
- Une **grille fonctions × actions** :
  - le sous-groupe porte le **plafond commun** ;
  - chaque membre reçoit **ses propres actions**, à l'intérieur de ce plafond.
- Un **périmètre** par membre :
  - un sous-groupe filiale est cantonné à sa filiale, sans exception ;
  - au siège, l'accès « toutes filiales » est accordé personne par personne.
- **Fiche d'habilitation** : création, validation N+1 puis N+2, verrouillage,
  notification de l'admin, bouton « Habiliter », PDF à la charte de
  l'entreprise.
- **Délégation** temporaire du droit de créer des fiches, qui expire
  d'elle-même.
- **Piste d'audit** complète, filtrable par rôle, groupe/sous-groupe,
  matricule et utilisateur.
- Contrôles de **séparation des tâches** qui **alertent** (ne bloquent pas).

## 3. Non-objectifs (v1)

- Revue périodique des habilitations (recertification par le N+1) — plus tard.
- Compte d'urgence (« break-glass ») — plus tard.
- Habilitation des acteurs hors tenant (super_admin, cabinet de recrutement) :
  inchangés.
- Gestion des utilisateurs, sécurité (SSO/MFA/SIEM), intégrations : restent
  **hors grille**, réservées à l'admin du tenant.

## 4. Anti-objectifs (échec même si « ça marche »)

- Un RH de filiale qui voit, par **n'importe quel chemin** (liste, recherche,
  export, rapport, IA, organigramme, URL directe), un dossier d'une autre
  filiale.
- Un aperçu « Ce que voit X » qui diverge des droits réellement appliqués.
- Une régression pour un tenant existant : ses utilisateurs doivent avoir
  exactement les mêmes accès qu'avant la livraison.
- Un nouveau module ajouté plus tard qui serait ouvert à tous par défaut.
- Une piste d'audit qui recopie des données personnelles (salaires, NNI…).

## 5. Ce qui a été décidé

### 5.1 Modèle d'organisation

- **Groupe** (ex. `DRH Groupe`) contient des **sous-groupes**. Un tenant peut
  créer autant de groupes et de sous-groupes qu'il veut.
- Type de sous-groupe :
  - **siège**, dont le périmètre par défaut est le tenant ;
  - **filiale**, rattaché à une `legal_entity` existante, dont le périmètre est
    cette filiale et rien d'autre.
- Une personne est habilitée dans **un** sous-groupe (v1).
- Un tenant sans filiale n'a que `DRH Groupe` → `RH Siège`.

### 5.2 Droits : plafond du sous-groupe + droits individuels

- Être dans un sous-groupe **ne donne aucun droit**.
- Le sous-groupe définit le **plafond** : les cases que ses membres *peuvent*
  recevoir.
- La fiche coche, pour la personne, un sous-ensemble de ce plafond.
- **Droits effectifs = droits de la fiche ∩ plafond du sous-groupe**, calculés
  à chaque requête. Retirer une action au sous-groupe la retire
  **immédiatement à tous ses membres**, sans fiche.
- Élargir le plafond d'un sous-groupe ne donne rien aux membres : il faut une
  nouvelle fiche pour la personne.
- Fermé par défaut : toute fonction absente de la grille d'un sous-groupe est
  refusée.

### 5.3 Grille

**Fonctions (lignes)** — issues de l'inventaire des modules NexusRH :

1. Dossiers employés (fiche, documents, photo)
2. Contrats (OHADA, propositions, contrats signés)
3. Absences et congés
4. Temps et badgeuse
5. Paie (calcul, éléments variables, bulletins)
6. Paie multi-filiales (fiche de variables, soumission filiale)
7. Déclarations (CNPS, DISA, ITS)
8. Paiements (virement, Mobile Money)
9. Notes de frais
10. Recrutement (offres, candidatures, sourcing, embauche)
11. Intégration et sorties (onboarding, offboarding, solde de tout compte)
12. Discipline
13. Formation et FDFP
14. Talents (évaluations, compétences, mobilité, succession, calibrage)
15. Climat social et marque employeur
16. Signature électronique
17. Reporting et indicateurs
18. Paramétrage RH (types d'absence, rubriques, circuits, départements)

**Actions (colonnes)** : Consulter · Créer · Modifier · Supprimer · Valider ·
Clôturer/Soumettre · Exporter · Payer/Envoyer · Paramétrer.

Seules les cases qui ont un sens pour la fonction sont proposées (par exemple,
« Payer » n'existe que pour Paiements).

**Case transverse** : « Voir les salaires et données sensibles ». Sans elle,
les champs de rémunération et d'identité sensible (NNI, RIB, numéro Mobile
Money) sont masqués partout, y compris dans les exports.

**Modèles de fiche** : des modèles préremplissent la grille, par exemple
Gestionnaire paie, Chargé de recrutement, RH de filiale ou DRH. Ils sont
paramétrables par le tenant. Ce sont des raccourcis de saisie, pas des
rôles : la fiche reste personnelle.

### 5.4 Périmètre

- Le périmètre est **relatif à la personne** : il est exprimé comme « la
  filiale de mon sous-groupe », pas comme une liste figée.
- **Sous-groupe filiale** : limité à sa filiale. Aucune case, modèle ou
  délégation ne peut l'étendre.
- **Sous-groupe siège** : périmètre = les employés **rattachés à aucune
  filiale** (`employees.legal_entity_id IS NULL`). Il ne s'étend à toutes les
  filiales que si la fiche coche « Accès toutes filiales » pour la personne.
  _Décision du porteur, 30/10._ Conséquence acceptée : un employé dont la
  filiale n'est pas renseignée relève du siège. L'écran des sous-groupes
  affiche donc le nombre d'employés sans filiale, pour qu'on les repère.
- **Son propre dossier** : une personne ne peut jamais modifier ni valider son
  propre salaire, sa propre sanction, sa propre paie ou sa propre fiche
  d'habilitation, même avec toutes les cases. Elle conserve son accès
  self-service d'employé.

### 5.5 Fiche d'habilitation

**Contenu** :
- personne habilitée ;
- groupe et sous-groupe ;
- périmètre, dont l'accès toutes filiales ;
- actions cochées ;
- modèle utilisé (facultatif) ;
- motif ;
- date d'effet.

**Qui crée** :
- le DRH (au niveau du groupe) ;
- le RH de filiale, pour sa filiale uniquement ;
- un délégataire dont la délégation est en cours (§5.6).

**Circuit** :

| Étape | Qui | Modifiable ? |
|---|---|---|
| Brouillon | créateur | oui |
| Chez le N+1 | N+1 de la personne habilitée | oui, par le N+1 |
| Chez le N+2 | N+2 de la personne habilitée | oui, par le N+2 |
| Validée → **verrouillée** | — | **non** |
| Notifiée à l'admin | admin tenant | non |
| Habilitée (droits appliqués) | admin tenant, bouton « Habiliter » | non |

Règles du circuit :
- Le N+1 et le N+2 sont lus dans la hiérarchie du dossier employé de la
  personne habilitée (« Responsable hiérarchique »). S'il n'y a pas de N+2, la
  fiche monte au DRH Groupe.
- Le créateur ne peut pas valider sa propre fiche. Si le créateur est le N+1,
  l'étape N+1 passe au validateur suivant.
- Le N+1 et le N+2 voient l'avant/après de chaque modification faite par
  l'autre.
- Un **refus** renvoie la fiche au créateur, avec un motif obligatoire. Elle
  repart ensuite du N+1.
- L'admin du tenant n'est notifié, dans son espace, **qu'une fois N+1 et N+2
  validés**.
- L'admin peut habiliter ou refuser, avec un motif. Il ne modifie pas la
  fiche.
- Une fiche verrouillée ne se modifie plus. Tout changement passe par une
  **nouvelle fiche**, qui refait tout le circuit ; l'ancienne reste dans
  l'historique. Quand la nouvelle est habilitée, elle remplace l'ancienne.
- **PDF** téléchargeable à toute étape, avec le logo, la couleur principale et
  les mentions légales (RCCM, CNPS, DGI). Il réutilise le moteur PDF de la
  proposition de contrat (`hr-document-pdf.ts`) et porte la mention
  « Brouillon » tant que la fiche n'est pas verrouillée.
- **Automatisable** : l'admin du tenant paramètre les circuits (N+1/N+2
  obligatoires), les modèles, les notifications et les rappels. Il peut aussi
  activer l'habilitation automatique dès la validation N+2, désactivée par
  défaut.

### 5.6 Délégation

- Le DRH et le RH de filiale peuvent déléguer le droit de **créer des fiches**
  à un membre de leur équipe. La date de fin est obligatoire.
- La délégation **expire d'elle-même** à échéance, sans action de personne.
- Le délégataire n'obtient jamais plus que le délégant (même périmètre au
  plus) et ne peut pas re-déléguer.
- La délégation est tracée : qui l'a donnée, à qui, du … au …, et les fiches
  créées pendant cette période.

### 5.7 Séparation des tâches — **alerte, pas blocage**

- Le tenant définit une liste de **cumuls sensibles**. Défauts proposés :
  - valider la paie et payer ;
  - créer un employé et valider la paie ;
  - créer un employé et payer ;
  - paramétrer la paie et valider la paie.
- Quand une fiche crée un cumul (droits existants de la personne compris),
  elle **n'est pas bloquée**. Elle affiche une **alerte visible** au N+1, au
  N+2 et à l'admin, qui décident en connaissance de cause.
- L'acceptation d'un cumul est tracée dans l'audit : qui a validé malgré
  l'alerte.

### 5.8 Piste d'audit

- Tout est tracé :
  - fiches : création, modification avec avant/après, validation, refus,
    habilitation ;
  - délégations ;
  - changements de plafond de sous-groupe ;
  - alertes de cumul acceptées ;
  - **actions RH faites avec ces droits**.
- Chaque entrée porte l'auteur, le rôle ou sous-groupe actif, la date et
  l'adresse IP. Elle ne recopie **jamais** de donnée personnelle (identifiants
  et noms de champs seulement).
- Filtres : rôle, groupe/sous-groupe, matricule, utilisateur, période. Export
  possible.

### 5.9 Aperçu « Ce que voit X »

L'aperçu montre l'accès réel d'une personne : fonctions, actions, filiales
couvertes et champs masqués. Il est **calculé par le même moteur** que le
contrôle d'accès des requêtes, jamais par un calcul parallèle.

### 5.10 Existant et nouveaux tenants

- **Nouveaux tenants** : modèle groupes dès la création. Le
  provisioning crée :
  - `DRH Groupe` → `RH Siège` ;
  - un `RH Filiale <nom>` par filiale déclarée, et à chaque nouvelle filiale ;
  - les modèles de fiche par défaut.
- **Bascule des tenants existants** (_décision du porteur, 30/10, remplace
  la précédente_) : **tous** les tenants existants passent au modèle groupes.
  Les utilisateurs RH actuels sont **placés d'office**, **sans fiche**, pour
  aller vite :
  - les utilisateurs non rattachés à une filiale vont dans le groupe
    `DRH Groupe` → `RH Siège` ;
  - les utilisateurs rattachés à une filiale (via leur dossier employé, ou le
    rôle `raf` d'une filiale) vont dans le sous-groupe `RH Filiale <nom>` de
    cette filiale.

  _Choix de Claude, pour zéro régression :_
  - les droits individuels de chaque membre sont dérivés de son rôle actuel,
    selon la matrice RBAC de `CLAUDE.md` ;
  - les membres du siège qui voient aujourd'hui toutes les filiales reçoivent
    « Accès toutes filiales » ;
  - le plafond de chaque sous-groupe est l'union des droits de ses membres.

  Cette mise en place est faite par une migration idempotente, et elle est
  tracée dans l'audit comme « Habilitation initiale (reprise de l'existant) ».
  Les ajouts et modifications suivants passent par une fiche d'habilitation.
  **Recette** : après la reprise, on teste le circuit complet avec de vraies
  fiches.
- **L'admin tenant** reste hors grille, avec tous les droits d'administration.
  C'est lui qui applique les fiches.
- **Un employé sans habilitation** garde son accès self-service et, s'il est
  manager, l'accès à son équipe selon `manager_scope`.

## 6. Contraintes

- Isolation tenant stricte (schéma issu du JWT), OWASP A01 :
  - contrôle **côté serveur** sur chaque route, y compris exports, recherches,
    rapports, IA et documents ;
  - l'interface ne fait que masquer.
- Le filtrage de périmètre filiale se fait **dans le SQL** (comme
  `manager_scope`), pas après coup en mémoire.
- Les droits effectifs sont recalculés à chaque requête, ou mis en cache avec
  une invalidation immédiate au retrait. Un retrait doit prendre effet sans
  reconnexion.
- Données : nouvelles tables dans le schéma tenant (provisioning + migration
  lazy), aucune donnée seed exécutée en prod.
- FR/EN (i18next), tests golden à jour (ui-api-contract, security-authz-sweep).

## 6 bis. Choix faits par Claude (à vérifier par le porteur)

- **Rôle et grille** : sur tous les tenants, la **grille est la seule
  source des droits RH**. Un membre habilité garde `users.role = employee`
  (self-service), plus `manager` s'il encadre une équipe. Les rôles
  `hr_manager` et `hr_officer` ne sont plus attribués. `dg` et `readonly`
  restent des rôles hors grille. Le rôle `raf` du circuit de paie
  multi-filiales devient l'action « Valider » de la fonction « Paie
  multi-filiales », dans un sous-groupe filiale. `authorize()` est enveloppé :
  sur un tenant à groupes, les routes RH consultent le moteur (fonction,
  action, périmètre).
- **DRH** : ce n'est pas un rôle. C'est l'action « Gérer les habilitations » de
  la fonction Paramétrage RH, au niveau du groupe ou du sous-groupe filiale.
  Elle permet de créer des fiches et de déléguer. Le premier DRH d'un nouveau
  tenant est habilité par l'admin, sans circuit, et c'est tracé. Une fiche
  sans N+2 monte à un titulaire de « Gérer les habilitations » au niveau du
  groupe, sinon à l'admin. Un N+1 ou N+2 sans compte utilisateur est sauté. Un
  N+1 ou N+2 qui serait la personne habilitée elle-même est aussi sauté.
- **Routes hors des 18 fonctions** :
  - assistant IA et recherche globale : ils héritent des droits de la
    personne, et l'IA n'interroge que ce que le moteur autorise ;
  - organigramme, tableau de bord et vue DG : rattachés à la fonction
    Reporting ;
  - export SAGE : action « Exporter » de la fonction Paie ;
  - classification : ajoutée à la fonction Paramétrage RH ;
  - simulations d'entretien : rattachées à la fonction Recrutement côté RH,
    et restent en self-service côté employé.
- **Données sensibles** : la case est **implicite** pour Paie, Déclarations et
  Paiements (ces documents n'ont pas de sens sans les montants). Le masquage
  ne s'applique donc qu'aux autres fonctions (dossiers, recrutement, talents,
  reporting).
- **Audit des actions RH** : sont tracées toutes les écritures, validations et
  exports, ainsi que les consultations de données sensibles (fiche salaire,
  NNI, RIB). Les simples consultations de listes ne sont pas tracées.
- **Dates** : la date d'effet est respectée. « Habiliter » avant cette date
  programme l'activation, et un job quotidien l'applique, le même que pour
  l'expiration des délégations. Une fiche n'a pas de date de fin en v1. On la
  retire par une fiche de retrait ou par le départ de la personne
  (offboarding), qui coupe tout automatiquement.

## 7. Laissé au builder

- Le schéma de tables exact, le nommage des permissions (`module:action`) et la
  stratégie de cache.
- L'intégration avec `authorize()` : wrapper, nouveau décorateur ou table de
  correspondance route → (fonction, action). Elle doit couvrir **toutes** les
  routes RH.
- Le découpage en lots livrables, par exemple :
  1. moteur et tables ;
  2. grille et sous-groupes ;
  3. fiche et circuit ;
  4. délégation, cumuls, audit et aperçu.
- Les écrans : leur disposition est libre, à la charte NexusRH existante.
