# NexusRH CI — Guide du Cabinet de Recrutement

**Édition spéciale partenaires : cabinets & agences de recrutement**
_La RH Intelligente, au service de l'Afrique qui avance_

OpenLab Consulting · Cocody, Rivièra Faya Lauriers 8, Abidjan · infos@openlabconsulting.com · +225 07 09 32 05 94

---

## 1. À qui s'adresse cette édition ?

NexusRH CI propose un **mode Cabinet de recrutement** : un espace dédié qui permet à votre cabinet de **gérer plusieurs entreprises clientes** (toutes en Côte d'Ivoire) depuis un **portail unique**, avec une équipe de recruteurs, tout en garantissant l'**isolation totale** des données de chaque client.

C'est l'offre idéale pour :

- les **cabinets de recrutement** et chasseurs de têtes gérant plusieurs PME/ETI clientes ;
- les **cabinets RH externalisés** (paie déléguée, administration du personnel) ;
- les **groupements / centres de services partagés RH**.

---

## 2. Ce que votre cabinet peut faire

| Capacité | Description |
| --- | --- |
| **Gérer plusieurs entreprises clientes** | Un seul compte cabinet, autant d'entreprises clientes (tenants) que nécessaire. |
| **Équipe de recruteurs** | Invitez vos collaborateurs : rôle **Propriétaire** (gère le cabinet, les membres, les clients) ou **Recruteur** (agit sur les clients). |
| **Onboarder une nouvelle entreprise** | Le cabinet crée lui-même une entreprise cliente (CI) ; elle lui est automatiquement rattachée. |
| **Gestion RH complète déléguée** | Sur chaque entreprise cliente, vous agissez comme administrateur RH : employés, contrats OHADA, paie (CNPS/ITS), absences, recrutement, formation, notes de frais, reporting. |
| **Recrutement de bout en bout** | Offres internes/externes au standard **APEC**, page carrières publique, pré-tri automatique, **scoring IA** (Claude/Mistral), sourcing IA, pipeline kanban. |
| **Connectivité** | Branchez vos outils (ATS, Slack, Zapier, comptabilité…) via webhooks signés, clés API et connecteurs REST (voir §6). |
| **Identité visuelle** | Logo et couleur du cabinet ; les e-mails d'invitation partent avec **votre adresse d'expéditeur**. |

---

## 3. Le parcours au quotidien

```
1. Connexion  →  owner@votre-cabinet.ci  →  Portail cabinet (/agency/dashboard)
2. « Mes clients »      →  voir / créer une entreprise cliente
3. « Membres »          →  inviter vos recruteurs (Propriétaire le fait)
4. Sélecteur d'entreprise (dashboard)  →  choisir un client
        ↓  (une « session » sécurisée s'ouvre sur ce client)
5. Vous travaillez DANS l'espace RH du client (employés, recrutement, paie…)
        Bannière permanente : « Vous agissez pour <Entreprise> via le cabinet <X> »
6. « Quitter »  →  retour au portail cabinet
```

- **Tableau de bord cabinet** : nombre d'entreprises clientes, nombre de membres, accès rapide.
- **Sélecteur d'entreprise** : un clic ouvre une session de travail sur l'entreprise choisie ; vous y disposez des droits d'administrateur RH.
- **Bannière « on-behalf »** : tant que vous agissez pour un client, une bannière l'indique en permanence — vous ne confondez jamais deux clients.

---

## 4. Recrutement — interne & externe (standard APEC)

- **Offres structurées APEC** : référence automatique, niveau d'expérience, statut, secteur, formation, avantages, mode de travail, date de prise de poste, processus de recrutement.
- **Visibilité par offre** : *Externe* (page carrières publique), *Interne* (réservée aux employés ciblés), *Mixte*.
- **Candidatures** : page carrières publique (anti-doublon e-mail) ; candidature interne ciblée par département / catégorie / ancienneté.
- **Pré-tri automatique** : règles « éliminatoires » configurables (compétences, diplôme, localisation, salaire, langues) → verdict *auto-reject* ou *revue humaine*.
- **Scoring IA + apprentissage** : score 0–100, forces/écarts/red flags/questions d'entretien ; l'IA **apprend de vos décisions** passées (hire/reject) pour calibrer le scoring.
- **Sourcing IA** : génération de profils candidats par plateforme (Wave, Africawork, Emploi.ci, Jobberman…). Le pays est **automatiquement celui de l'entreprise cliente** (pas de sélecteur superflu pour une entreprise mono-pays).
- **Pipeline kanban** : `nouveau → présélection → entretien → test → offre → recruté/rejeté`.

---

## 5. Sécurité & confidentialité (essentiel pour un cabinet)

La confidentialité entre vos clients est **garantie par conception** :

- **Isolation stricte par entreprise** : chaque entreprise cliente vit dans une base de données dédiée (schéma PostgreSQL séparé). Les données d'un client ne sont **jamais** accessibles depuis un autre.
- **Accès cloisonné** : un recruteur ne peut agir que sur les entreprises **rattachées à votre cabinet**, et uniquement après ouverture d'une session sur cette entreprise. Toute tentative hors périmètre est refusée.
- **Sessions de travail à durée limitée** : agir au nom d'une entreprise ouvre une session **expirant automatiquement (30 min)**, re-validée à chaque renouvellement.
- **Traçabilité « on-behalf »** : chaque action menée par le cabinet pour le compte d'un client est **journalisée** (qui, pour quel client, quand) — auditabilité totale (conformité loi 2013-450 CI).
- **Révocation immédiate** : si l'éditeur suspend un cabinet, toutes les sessions de ses membres sont **coupées sans délai**.
- **Secrets protégés** : clés API hachées, secrets de connecteurs chiffrés (AES-256), mots de passe forts + MFA (TOTP) disponible.
- **Restriction Côte d'Ivoire** : un cabinet ne peut rattacher/créer que des entreprises **CI** (garde-fou serveur).

> Conformité OWASP 2025 (A01 contrôle d'accès, A02 chiffrement, A03 validation, A09 journalisation, A10 anti-SSRF) — voir `docs/OWASP-2025-AUDIT.md`.

---

## 6. Connectivité — interfacer NexusRH à vos outils

Depuis **Paramètres → Connectivité** (administrateur), pour chaque entreprise cliente :

- **Webhooks sortants** — NexusRH **pousse** les événements RH (employé créé, absence approuvée, note de frais approuvée…) vers vos outils (Slack, Zapier, Make, ATS…). Chaque envoi est **signé (HMAC SHA-256)** et journalisé.
- **Clés API entrantes** — vos outils **lisent** les données via une API dédiée (`/integrations/v1/…`), avec des **portées** précises (`employees:read`, `payroll:read`…), des clés révocables et traçées.
- **Connecteurs REST génériques** — branchez n'importe quelle API tierce (URL + authentification Bearer/Basic/clé), avec bouton « Tester ».

Toutes les URL sortantes sont protégées contre les attaques SSRF (les adresses internes sont refusées).

---

## 7. Conformité Côte d'Ivoire incluse

CNPS 2024 (retraite, prestations familiales, AT par secteur), ITS/DGI (barème + crédits famille), SMIG, congés (jours ouvrables), **DISA** (loi 99-477), **e-CNPS**, contrats **OHADA**, formation **FDFP**, paiement salaires **Mobile Money** (Wave, MTN, Orange). Devise **FCFA** exclusivement.

---

## 8. Démarrage

1. OpenLab Consulting crée votre **cabinet** et votre compte **Propriétaire** (vous recevez vos identifiants par e-mail).
2. Connectez-vous → **changez votre mot de passe** → activez le **MFA** (recommandé).
3. **Paramètres cabinet** : logo, couleur, **adresse d'expéditeur** des invitations.
4. **Invitez vos recruteurs** (Membres).
5. **Créez ou faites rattacher vos entreprises clientes**.
6. Sélectionnez un client et commencez : employés, offres, paie…

---

## 9. Support

**OpenLab Consulting** · Support WhatsApp **+225 07 09 32 05 94** · support@nexusrh-ci.com
Horaires : Lun–Ven 7h30–18h00 (heure d'Abidjan)

---

_NexusRH CI — Édition Cabinet de recrutement · Propulsé par Claude AI (Anthropic) · Conforme Code du Travail ivoirien & CNPS 2024_
