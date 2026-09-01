# Rapport statistique 360° — conception

**Date** : 2026-09-01
**Statut** : validé, prêt pour le plan d'implémentation

## Objectif

Envoyer à l'éditeur de la plateforme un rapport périodique qui ne se contente pas
de compter, mais désigne ce qui mérite son attention pour améliorer NexusRH :
état du parc de tenants, activité des cabinets, effectifs, connexions, incidents.

Deux cadences :

- **hebdomadaire**, chaque dimanche, sur les 7 jours écoulés ;
- **mensuelle**, le 1er du mois, sur le mois calendaire précédent.

## Destinataires

| Rôle | Adresse |
|---|---|
| Principal | `waopron@openlabconsulting.com` |
| Copie | `coulwao@gmail.com` |

Les adresses sont **paramétrables par variables d'environnement**
(`PLATFORM_REPORT_TO`, `PLATFORM_REPORT_CC`), avec ces valeurs par défaut. Une
adresse en dur dans le code obligerait à reconstruire une image pour la changer.

## Contenu

### 1. Vue plateforme

- Entreprises par statut : actives, en essai, suspendues.
- Effectif total consolidé, et sa variation sur la période.
- Nouveaux tenants créés sur la période.
- Répartition par plan (`plan_type`) et par secteur — **camemberts** (PDF).
- Évolution sur les 12 dernières périodes — **barres** (PDF).

### 2. Par cabinet

Pour chaque cabinet (`platform.agencies` actif) :

- nombre d'entreprises gérées (`agency_tenants` où `detached_at IS NULL`) ;
- effectif cumulé de ses entreprises ;
- entreprises rattachées et détachées sur la période ;
- part du cabinet dans le parc total — **camembert** (PDF).

### 3. Par entreprise

Pour chaque tenant :

- effectif actif (`employees` où `is_active`) ;
- **arrivées et départs de la période** — en nombre et répartition (type de
  contrat, service), **sans identité nominative** (voir « Sécurité et RGPD ») ;
- comptes utilisateurs actifs, et combien se sont connectés sur la période ;
- date de dernière connexion, tous comptes confondus ;
- taux de connexion = comptes s'étant connectés / comptes actifs ;
- volume d'activité, tiré du nombre d'écritures dans `audit_log`.

### 4. Connexions et incidents

Depuis l'`audit_log` de chaque tenant :

- connexions réussies par jour — **barres** (PDF) ;
- `auth.login.failed`, `auth.login.locked`, `auth.login.mfa_required`,
  `auth.login.blocked_offline` ;
- classement des entreprises les plus touchées par les échecs.

> Périmètre assumé de ce premier lot : les « erreurs » sont celles que la base
> trace **aujourd'hui**, c'est-à-dire l'audit. Il n'existe aucune table d'erreurs
> applicatives — les 500, échecs d'envoi d'e-mail et jobs en échec ne sont écrits
> nulle part. Leur capture est un chantier distinct, à mener ensuite ; le rapport
> l'absorbera sans changer de structure.

### 5. Signaux d'attention

C'est le bloc qui rend le rapport actionnable :

- entreprises sans **aucune** connexion depuis 14 jours ;
- essais (`status = 'trial'`) arrivant à échéance sous 14 jours ;
- plafonds `max_employees` ou `max_users` atteints à 90 % ou plus ;
- entreprises dont l'effectif a baissé sur la période ;
- tenants dont la collecte a échoué (schéma indisponible).

## Sources de données

Toutes les données existent déjà ; aucune migration de schéma métier n'est requise.

| Donnée | Source |
|---|---|
| Tenants, plan, statut, plafonds, essai | `platform.tenants` |
| Cabinets | `platform.agencies` |
| Rattachements cabinet ↔ entreprise | `platform.agency_tenants` (`detached_at`) |
| Effectifs, arrivées, contrats, services | `<schema>.employees` (`is_active`, `hire_date`, `created_at`, `contract_type`, `department_id`) |
| Comptes et connexions | `<schema>.users` (`is_active`, `last_login_at`, `role`) |
| Connexions, échecs, verrouillages, activité | `<schema>.audit_log` (`action`, `created_at`) |

## Architecture

Le rapport vit dans le **worker** : il y dispose déjà de l'infrastructure de crons
BullMQ, d'un accès direct à PostgreSQL et d'un transporteur SMTP. L'alternative
— générer côté API sur déclenchement du worker — imposerait une authentification
service-à-service pour un gain nul. Un planificateur interne à l'API enverrait le
rapport en double le jour où elle passerait à deux répliques.

```
apps/worker/src/report/
  types.ts         ReportData, AgencyStats, TenantStats, Alert
  collect.ts       requêtes SQL — SEUL module qui touche la base
  analyze.ts       PUR : classements, séries, signaux d'attention
  render-html.ts   PUR : ReportData → corps du mail
  render-pdf.ts    ReportData → Uint8Array (pdf-lib)
apps/worker/src/jobs/platform-report.ts   orchestration et envoi
```

Le découpage suit le patron déjà en place dans `attendance-core/` : les entrées
et sorties sont isolées dans un module, la logique est pure et testable sans base
ni SMTP.

`pdf-lib` est ajouté aux dépendances du worker. C'est la bibliothèque déjà
utilisée par l'API pour les bulletins de paie, l'organigramme et les attestations
(`PDFDocument.create()`, `embedFont`, `rgb`) : aucune bibliothèque nouvelle
n'entre dans le dépôt.

> Vérifié à la rédaction du plan : `pdfkit` est bien déclaré dans les
> dépendances de l'API mais n'y est **utilisé nulle part** — c'est `pdf-lib` qui
> rend tous les PDF. Ne pas se fier au nom déclaré. Le nettoyage de cette
> dépendance morte est hors périmètre de ce lot.

## Rendu

**Corps du mail (HTML)** — l'essentiel doit être lisible sans rien ouvrir :
tableaux de synthèse et barres en HTML/CSS. Ni JavaScript ni SVG : Gmail et
Outlook n'exécutent pas le premier et bloquent le second.

**PDF joint** — les vrais graphiques (barres, camemberts) et le détail complet par
cabinet et par entreprise, dessinés avec `pdf-lib`.

Au-delà de **50 entreprises**, le PDF détaille les 50 premières par effectif et
agrège le reste. Sans cette borne, le rapport devient illisible et lourd à mesure
que le parc grandit.

## Cadence et idempotence

Deux planifications via `upsertJobScheduler`, en `Africa/Abidjan` comme les crons
existants :

| Rapport | Expression | Période couverte |
|---|---|---|
| Hebdomadaire | `0 6 * * 0` | les 7 jours écoulés (dimanche → samedi) |
| Mensuel | `15 6 1 * *` | le mois calendaire précédent |

Nouvelle table :

```sql
CREATE TABLE IF NOT EXISTS platform.report_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_type   varchar(10)  NOT NULL,   -- 'weekly' | 'monthly'
  period_start  date         NOT NULL,
  period_end    date         NOT NULL,
  status        varchar(20)  NOT NULL,   -- 'sent' | 'failed'
  recipients    text         NOT NULL,
  error_message text,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (period_type, period_start)
);
```

L'unicité sur `(period_type, period_start)` est l'anti-doublon : un second
déclenchement pour la même période est ignoré. La table donne aussi la trace des
rapports envoyés — et de ceux qui ont échoué.

## Robustesse

- **Un tenant cassé ne fait pas tomber le rapport.** La collecte est isolée par
  tenant ; celui qui échoue est marqué « données indisponibles » et remonte dans
  les signaux d'attention.
- **Échec d'envoi** : le job échoue, BullMQ retente 3 fois en espacement
  exponentiel, la ligne `report_runs` reste en `failed` jusqu'au succès.
- **Parc vide ou période sans activité** : le rapport part quand même, en
  indiquant explicitement l'absence de données — un silence serait indistinguable
  d'une panne.

## Sécurité et RGPD

**Aucune identité de salarié dans le rapport.** Les arrivées et départs sont
donnés en nombre et en répartition (type de contrat, service), jamais en nom.
NexusRH est sous-traitant des données RH de ses clients : envoyer des noms de
salariés d'une entreprise cliente vers une boîte Gmail en copie serait difficile
à justifier lors d'un contrôle. Les chiffres et les tendances donnent le même
pilotage. Décision prise avec l'utilisateur le 01/09/2026.

**Échappement HTML obligatoire** sur les noms de cabinets et d'entreprises : ils
sont saisis par des utilisateurs, et sans échappement on ouvrirait une injection
HTML directement dans la boîte du destinataire.

**Pas de secret dans le rapport** : ni jeton, ni adresse e-mail de salarié, ni
identifiant technique exploitable.

## Tests

| Module | Ce qui est vérifié |
|---|---|
| `analyze` | classements, séries, chaque règle de signal d'attention, période sans activité |
| `render-html` | présence des sections, **échappement** d'un nom de tenant hostile |
| `render-pdf` | document valide (`%PDF`), sections présentes, borne des 50 entreprises |
| `collect` | SQL avec `pg` mocké, **tolérance à un schéma en erreur** |
| `platform-report` | anti-doublon via `report_runs`, destinataires, comportement en échec d'envoi |

## Hors périmètre

Volontairement écartés de ce lot, pour livrer vite et sans risque :

- capture des erreurs applicatives (table dédiée) — chantier suivant ;
- écran de consultation dans le portail super_admin — le mail et son PDF
  suffisent, décision prise avec l'utilisateur ;
- export CSV, comparaison entre périodes arbitraires, envoi à la demande.
