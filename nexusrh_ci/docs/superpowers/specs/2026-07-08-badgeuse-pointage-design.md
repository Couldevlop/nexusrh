# Conception — Module Badgeuse / Pointage (`attendance`)

> NexusRH CI · SIRH SaaS multi-tenant · OpenLab Consulting
> Date : 2026-07-08 · Statut : validé (brainstorming) · Auteur : équipe NexusRH
> Périmètre : **Phase 1 (horaire fixe)**. Phase 2 (équipes/rotations) = spec séparée ultérieure.

## 1. Objectif

Permettre aux entreprises utilisant des **badgeuses** (lecteurs RFID, QR, terminaux type
ZKTeco/Suprema/Hikvision…) de remonter les pointages dans NexusRH, d'y détecter
**retards répétés** et **absences non justifiées**, et de déclencher une **escalade
disciplinaire** (avertissement → demande d'explication → brouillon de sanction validé
par le RH) conforme au Code du Travail ivoirien (procédure contradictoire).

Nouveau **module opt-in `attendance`**, activable par tenant (comme `dg_view`),
réservé aux profils RH. **Aucune régression** : désactivé par défaut, tables additives,
zéro modification d'endpoint ou de table existants.

## 2. Décisions structurantes (validées)

| Sujet | Décision |
|---|---|
| Sens d'intégration | **NexusRH appelle** (client sortant) les API des badgeuses et **tire** (poll) les pointages. Les badgeuses ne poussent pas. |
| Connexion badgeuse | Connecteur REST sortant **chiffré** (patron `integration_connectors`) + **garde SSRF** + **mapping JSON configurable** (pas d'adaptateur par marque). |
| Horaire de référence | **Fixe** : défaut tenant, surchargeable département puis employé. Équipes/rotations = phase 2. |
| Absence injustifiée | Jour ouvré **sans badge** = injustifiée, **SAUF** congé/absence approuvé (→ justifié) ou jour non ouvré / férié CI (→ off). |
| Paliers de retard | **Les deux paliers comptent** : une journée ≥ 1 h compte au palier 30 min **ET** au palier 1 h (compteurs indépendants). |
| Sanction finale | **Brouillon pré-rempli** dans le module discipline, **validé par le RH**. Jamais d'émission automatique. |

## 3. Architecture — 5 composants isolés

1. **Connecteur badgeuse (récupération)** — config sécurisée + mapping JSON + curseur de synchro ;
   job de poll qui tire, normalise et enregistre les pointages.
2. **Horaire de référence** — résolution en cascade employé > département > tenant.
3. **Moteur de calcul présence** — dérive un statut quotidien par employé (présent / retard /
   absence justifiée / absence injustifiée / off).
4. **Moteur d'escalade** — compte les occurrences, génère avertissements et demandes
   d'explication, crée le brouillon de sanction à 2 avertissements.
5. **Surfaces & notifications** — écrans RH, self-service employé, écrans de configuration ;
   notifications via `notifyUser`.

## 4. Modèle de données (schéma tenant, provisioning paresseux)

### 4.1 `attendance_devices` — une badgeuse
`id`, `name`, `base_url`, `auth_type` (none/bearer/basic/api_key), `auth_secret_enc` (AES-256),
`auth_header_name`, `default_headers` (jsonb), `field_mapping` (jsonb), `poll_enabled` (bool),
`poll_interval_min` (int, défaut 15), `sync_cursor` (text — dernier pointage tiré),
`last_sync_at`, `last_sync_status`, `is_active`, `created_by`, `created_at`, `updated_at`.

`field_mapping` (jsonb) :
```json
{
  "recordsPath": "data.records",     // où trouver le tableau de pointages
  "employeePath": "user_id",          // champ identifiant employé dans un enregistrement
  "employeeMatchBy": "matricule",     // matricule | email | badge_id
  "timestampPath": "punch_time",
  "timestampFormat": "iso8601",       // iso8601 | epoch_s | epoch_ms | "YYYY-MM-DD HH:mm:ss"
  "directionPath": "state",           // optionnel
  "directionInValue": "0",            // valeur = entrée
  "directionOutValue": "1"            // valeur = sortie
}
```
*Table dédiée (et non réutilisation de `integration_connectors`) pour garder le module
autonome ; on réutilise les helpers `encrypt` / `decryptIfPresent` / `isSafeOutboundUrl`.*

### 4.2 `attendance_punches` — pointage brut normalisé
`id`, `employee_id` (nullable si non rapproché), `raw_employee_ref` (text),
`device_id` (fk attendance_devices), `punched_at` (timestamptz), `direction` (in/out/unknown),
`source` (device/manual/import), `raw` (jsonb, enregistrement d'origine), `dedup_key` (text),
`created_at`. **Unique (device_id, dedup_key)** → idempotence du poll.

### 4.3 `attendance_schedules` — horaire de référence
`id`, `scope` (tenant/department/employee), `scope_id` (uuid nullable), `expected_start` (time),
`tolerance_min` (int, défaut 10), `expected_end` (time nullable), `workdays` (int[] — 1=lun…7=dim,
défaut {1,2,3,4,5}), `is_active`, `created_at`, `updated_at`.
Résolution : employé > département > tenant.

### 4.4 `attendance_days` — statut quotidien calculé
`id`, `employee_id`, `work_date` (date), `first_in` (timestamptz null), `last_out` (timestamptz null),
`expected_start` (time — snapshot), `late_minutes` (int, 0 si à l'heure),
`status` (present/late/absent_unjustified/absent_justified/off), `justified_by` (uuid null → absence),
`computed_at`. **Unique (employee_id, work_date)**. Recalculable idempotemment.

### 4.5 `attendance_warnings` — avertissements générés
`id`, `employee_id`, `tier` (avertissement/demande_explication), `trigger_reason` (text — ex.
`30min_x3_month`, `60min_x3_consecutive`, `unjustified_absence`), `occurrence_dates` (date[]),
`threshold_snapshot` (jsonb), `status` (active/explained/contested/closed),
`employee_response` (text null), `responded_at` (timestamptz null),
`disciplinary_action_id` (uuid null → disciplinary_actions), `created_at`.
Seuls `active` et `contested` comptent vers la sanction.

### 4.6 `attendance_config` — singleton tenant
`id`, `late_minutes_tier1` (30), `occurrences_tier1` (3), `late_minutes_tier2` (60),
`occurrences_tier2` (3), `unjustified_absence_occurrences` (1), `warnings_before_sanction` (2),
`window_mode` (`consecutive_or_month`), `default_expected_start` (08:00),
`default_tolerance_min` (10), `default_workdays` (int[]), `updated_at`.
INSERT idempotent + SELECT avec ORDER BY (patron singleton `platform_settings`).

### 4.7 Lien discipline (table existante inchangée)
À 2 avertissements comptants, INSERT dans `disciplinary_actions` :
`type='avertissement'`, `status='draft'`, `reason`/`description` pré-remplis (historique),
via colonnes existantes. Back-reference stocké sur `attendance_warnings.disciplinary_action_id`.
**`disciplinary_actions` n'est pas modifiée.**

## 5. Moteur d'escalade — logique précise

**Déclenchement** : job quotidien `attendance-evaluate` (et après chaque poll pour les jours
affectés). Recalcule `attendance_days` puis évalue par employé.

**Qualification d'une journée en retard** : `late_minutes = max(0, first_in − (expected_start + tolerance))`.
Une journée compte comme occurrence pour **chaque palier dont elle dépasse le seuil** :
- `late_minutes ≥ late_minutes_tier2` → occurrence palier 1 **et** palier 2 ;
- `late_minutes ≥ late_minutes_tier1` (et < tier2) → occurrence palier 1 seul.

**Fenêtres (`window_mode = consecutive_or_month`)** — un palier déclenche si :
- **consécutif** : `occurrences_tierN` journées-occurrences sur des jours ouvrés consécutifs ; **ou**
- **même mois** : `occurrences_tierN` journées-occurrences dans le même mois civil.

**Consommation par palier** : les jours ayant déclenché un palier sont enregistrés dans
`occurrence_dates` du warning et exclus des évaluations suivantes **de ce palier**
(indépendant entre paliers → un jour peut alimenter les deux compteurs).

**Absence injustifiée** : chaque jour `absent_unjustified` génère un warning
`tier=avertissement`, `trigger_reason='unjustified_absence'` (seuil `unjustified_absence_occurrences`,
défaut 1). Exception : congé/absence approuvé couvrant le jour → `absent_justified` (pas de warning) ;
week-end/férié CI → `off`.

**Procédure contradictoire** : une `demande_explication` est répondable par l'employé
(`employee_response`). Le RH marque `explained` (→ ne compte plus) ou maintient (`contested`/`active`).

**Sanction** : dès que le nombre de warnings `active|contested` d'un employé atteint
`warnings_before_sanction` (2), création d'un brouillon `disciplinary_actions` (historique
pré-rempli) + notification RH. Aucune émission automatique.

**Notifications** : chaque avertissement/demande d'explication est poussé dans l'espace RH
**et** l'espace employé via `notifyUser`.

## 6. Sécurité & robustesse

- **SSRF** : `isSafeOutboundUrl(base_url)` à la création/modif **et avant chaque poll**
  (anti DNS-rebinding vers IP interne).
- **Secrets** : `auth_secret_enc` chiffré AES-256, jamais renvoyé (masqué comme le SMTP tenant).
- **Appels sortants** : TLS, timeouts connexion/socket, retries bornés ; une badgeuse
  injoignable n'affecte ni les autres appareils ni l'app (statut `last_sync_status`).
- **Rate-limiting** sur les endpoints de config ; poll en file BullMQ (jamais synchrone HTTP).
- **RBAC** : config = `admin` (+ `hr_manager`) ; exploitation = `admin`/`hr_manager`/`hr_officer`,
  `manager` limité à son équipe, `employee` à ses propres données. Discipline reste RH-only.
- **Isolation tenant** (`schemaName` du token) + **audit_log** de chaque warning, réponse
  d'explication et brouillon de sanction.

## 7. Endpoints (`/attendance`, module opt-in + RBAC)

**Config (admin)**
- `GET/PUT /attendance/config`
- `GET/POST/PATCH/DELETE /attendance/devices`
- `POST /attendance/devices/:id/test` — test de connexion
- `POST /attendance/devices/:id/sync` — poll manuel immédiat (enfile un job)
- `GET/POST/PATCH/DELETE /attendance/schedules`

**Exploitation (RH ; manager = son équipe)**
- `GET /attendance/punches` · `POST /attendance/punches` (correction manuelle)
- `GET /attendance/days` · `POST /attendance/recompute`
- `GET /attendance/warnings` · `PATCH /attendance/warnings/:id`
- `GET /attendance/dashboard` — KPIs

**Self-service employé**
- `GET /attendance/me` · `GET /attendance/me/warnings`
- `POST /attendance/me/warnings/:id/respond`

## 8. Écrans web

- **RH** — page `Badgeuse` (onglets) : Tableau de bord · Pointages · Retards & absences ·
  Avertissements (+ brouillons de sanction) · Configuration (badgeuses + mapping JSON, horaires, seuils).
- **Employé** — dans `/mon-espace` : Mes pointages · Mes avertissements (bouton **répondre**).
- Sidebar conditionnée au module `attendance` + rôle.

## 9. Jobs worker (BullMQ)

- `attendance-poll` — par badgeuse active, toutes les `poll_interval_min` : tire depuis
  `sync_cursor`, mappe via `field_mapping`, rapproche l'employé (`employeeMatchBy`),
  déduplique (`dedup_key`), enregistre, met à jour le curseur et `last_sync_status`.
- `attendance-evaluate` — quotidien + à la fin d'un poll (jours affectés) : recalcule
  `attendance_days` puis exécute l'escalade.

## 10. Anti-régression (contrainte dure)

- Module **opt-in** (`enabled_modules`) → invisible/inactif tant que non activé.
- Toutes les tables **additives** ; `disciplinary_actions` **non modifiée** (INSERT de brouillons
  via colonnes existantes).
- Nouveau préfixe `/attendance` déclaré dans la **carte PREFIX** du golden `ui-api-contract` ;
  endpoints ajoutés au golden `forms-submission` (pièges connus du repo).
- Nouveau namespace i18n `attendance` (FR/EN) ; clé module dans `web/src/lib/modules.ts`.
- Jobs worker bornés par tenant/appareil ; aucun impact sur les jobs existants.
- Zéro modification d'endpoint ou de table existants ; RBAC discipline inchangé.

## 11. Tests

- **Service pur** (moteur d'escalade) : qualification des paliers (double comptage ≥1 h),
  fenêtres consécutif/mois, consommation par palier, seuil 2 avertissements → brouillon,
  exception congé approuvé / férié / week-end.
- **Mapping** : extraction depuis divers `field_mapping` (chemins, formats d'horodatage, sens).
- **Routes** : RBAC (manager = son équipe, employé = ses données), Zod strict, SSRF → 422,
  secrets masqués, idempotence recompute.
- **Golden** : `ui-api-contract` (préfixe + endpoints), `forms-submission` (nouveaux POST/PATCH/PUT).
- **Non-régression** : suite complète API verte + typecheck ; module désactivé = comportement
  identique à l'existant.

## 12. Hors périmètre (phase 2, spec séparée)

- Équipes / rotations / plannings tournants (3×8).
- Calcul d'heures supplémentaires à partir des pointages.
- Export paie des heures pointées / intégration au moteur de paie.
- Géolocalisation / pointage mobile natif (le sens actuel = badgeuses physiques via API).
