# Simulateur de paie UEMOA — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** remplacer le simulateur ITS ivoirien par un simulateur de paie multi-pays UEMOA, adossé au moteur de paie et aux packs législatifs.

**Architecture :**
- Les packs reçoivent une règle d'ancienneté (`seniorityBonus`).
- Un service pur calcule l'ancienneté et les heures supplémentaires.
- Deux routes `/payroll/simulator/*` exposent les métadonnées pays et la simulation, déléguée à `calculatePayrollCI`.
- La page web est pilotée par ces métadonnées.

**Tech Stack :** Fastify 5 + Zod, vitest, React 18 + TanStack Query, i18next.

**Spec :** `nexusrh_ci/docs/superpowers/specs/2026-11-04-simulateur-paie-uemoa-design.md`

## Global Constraints

- Aucun taux, plafond ni barème écrit en dur dans le web : tout vient de `GET /payroll/simulator/countries`.
- Aucune valeur inventée : une donnée absente du pack donne `null`, un champ désactivé et la mention « non paramétré ».
- Montants entiers, arrondis avec `Math.round` sauf si le moteur arrondit déjà autrement : réutiliser l'arrondi du moteur.
- Les fixtures golden existantes du moteur (`apps/api/src/services/golden`) restent vertes. Les libellés CI d'heures supplémentaires du bulletin, eux, changent : ils suivent le décret n° 2024-898 (art. 25), conformément à la décision du 04/11/2026 (tâche 1b) ; les fixtures ont été recalculées à la main en tâche 1b.
- Accès : `authorize('admin', 'hr_manager', 'hr_officer')` ; 400 avec un message français précis pour toute incohérence.
- TypeScript strict : pas de `any`, pas de `@ts-ignore`. i18n en FR et EN, namespace `payroll`.
- Nouveaux fichiers sous `nexusrh_ci/` : `git add -f`.
- Ne jamais indexer `nexusrh_ci/k8s/**`, `apps/web/vite.config.ts`, `apps/worker/Dockerfile` ni `NEXUSRH_CI_Test_Plan.xlsx`.
- Commits en français, sans ligne Co-Authored-By ni pied de page Claude.
- Machine à mémoire limitée : un seul vitest à la fois, `--maxWorkers=2` au plus.

## Review Focus

1. **Embauche en fin de mois ou un 29 février.** Le nombre d'années révolues ne doit ni sauter ni perdre un an (test en tâche 1).
2. **Changement de pays avec un résultat affiché.** Aucune valeur du pays précédent ne doit rester : taux AT hors bornes, zone inconnue (test web en tâche 3, test 400 en tâche 2).
3. **Pays sans plafond de transport ou sans majoration.** Pas de valeur par défaut fabriquée (tests en tâches 2 et 3).
4. **Salaire de base sous le minimum de catégorie ou sous le SMIG.** Avertissement dans le résultat, pas d'erreur 500 (tâche 2).
5. **Libellés d'heures supplémentaires CIV.** Dérivés du pack et conformes au décret n° 2024-898 (art. 25) depuis la décision du 04/11/2026 (tâche 1b) : 1400 +15 % (41e à 46e h), 1450 +50 % (au-delà de 46 h), 1500 +75 % nuit, 1520 +75 % dimanche/férié de jour, 1550 +100 % dimanche/férié de nuit. Ne pas revenir aux anciens libellés (golden `payroll-engine-ot-labels`).

---

### Task 1: Règle d'ancienneté dans les packs, service de calcul, libellés d'heures supplémentaires

**Files :**
- Modify : `apps/api/src/services/legislation-packs.ts`
  - Ajouter l'interface `SeniorityBonusRule` et le champ `seniorityBonus?` exactement comme dans la spec.
  - Renseigner les valeurs du tableau de la spec (CIV, SEN, MLI, NER, BFA, TGO ; rien pour BEN et GNB).
- Create : `apps/api/src/services/payroll-simulator.service.ts`
- Modify : `apps/api/src/services/payroll-engine-ci.ts`, pour dériver du pack les libellés des lignes 1400, 1500 et 1550.
- Test : `apps/api/src/services/payroll-simulator.service.test.ts`, `apps/api/src/services/payroll-engine-ot-labels.golden.test.ts`

**Interfaces (produit) :**
- `completedYears(hireDate: string, payMonth: string): { years: number; months: number }`
  - Années et mois révolus au dernier jour du mois de paie.
  - Lève `RangeError` si l'embauche est postérieure à ce dernier jour.
- `seniorityRate(rule: SeniorityBonusRule, years: number): number`
- `computeSeniority(input: { pack: LegislationPack; hireDate: string; payMonth: string; baseSalary: number; categoryMinimum: number; override?: number }): SeniorityResult`
  - `SeniorityResult = { years, months, rate, base, amount, source: 'rule'|'manual'|'none', confidence: 'confirmed'|'to_confirm'|null, legalSource: string|null }`
- `hourlyRate(baseSalary: number, weeklyHours: number): number`, qui vaut `baseSalary / (weeklyHours * 52 / 12)`, non arrondi.
- `computeOvertime(pack: LegislationPack, baseSalary: number, weeklyHours: number, hours: { weekly: number; night: number; sunday: number; holiday: number }): { lines: OvertimeLine[]; variableElements: { HEURES_SUPP_NORM?: number; HEURES_SUPP_NUIT?: number; HEURES_SUPP_FERIE?: number } }`
  - Lève une erreur si des heures sont saisies pour une majoration absente du pack.
- `overtimeLabels(pack: LegislationPack): { norm: string; nuit: string; ferie: string }`, exporté par le moteur.

- [ ] **Step 1 : tests en échec.**
  - Taux d'ancienneté par pack, avec les taux attendus :
    - CIV : 0 et 1 an → 0 ; 2 → 0,02 ; 3 → 0,03 ; 10 → 0,10 ; 25 → 0,25 ; 30 → 0,25.
    - SEN : identique à CIV.
    - MLI : 2 → 0 ; 3 → 0,03 ; 4 → 0,03 ; 5 → 0,05 ; 10 → 0,10 ; 15 → 0,15 ; 30 → 0,15.
    - NER : 2 → 0 ; 3 → 0,03 ; 10 → 0,10 ; 24 → 0,24 ; 30 → 0,24.
    - BFA : 2 → 0 ; 3 → 0,05 ; 10 → 0,12 ; 40 → 0,42 (pas de plafond).
    - TGO : 2 → 0,02 ; 3 → 0,02 ; 4 → 0,03 ; 10 → 0,09 ; 31 → 0,30 ; 40 → 0,30.
    - BEN et GNB : `seniorityBonus` est `undefined`.
  - `completedYears` :
    - embauche `2016-11-30`, mois `2026-11` → 10 ans 0 mois ;
    - embauche `2016-12-01`, mois `2026-11` → 9 ans 11 mois ;
    - embauche `2020-02-29`, mois `2024-02` → 4 ans 0 mois ;
    - embauche `2020-02-29`, mois `2025-02` → 5 ans 0 mois ;
    - embauche `2026-12-01`, mois `2026-11` → `RangeError`.
  - `computeSeniority` :
    - CIV, embauche à 10 ans, minimum de catégorie 150 000, base 400 000 → montant 15 000, source `'rule'`.
    - BFA, base 200 000, 10 ans → assiette 200 000, montant 24 000.
    - Override 50 000 → montant 50 000, source `'manual'`.
    - BEN sans override → montant 0, source `'none'`.
  - `computeOvertime` :
    - CIV, base 400 000, 40 h, 10 heures `weekly` → taux horaire `400000/(40*52/12)`, montant `Math.round(10 * th * 1.15)`.
    - Night et sunday s'additionnent dans `HEURES_SUPP_NUIT`.
  - `overtimeLabels` :
    - CIV donne `Heures supp. +15%`, `Heures supp. +50% (nuit/dim)`, `Heures supp. +100% (jour férié)`.
    - TGO, où la nuit (0,5) diffère du dimanche (0,65), donne `Heures supp. nuit (+50%) / dimanche (+65%)` pour `nuit`.
- [ ] **Step 2 :** lancer les tests. Attendu : FAIL.
- [ ] **Step 3 : implémenter.**
  - Le moteur utilise `overtimeLabels(pack)` à la place des libellés figés de `VARIABLE_EARNINGS` pour les codes 1400, 1500 et 1550.
  - Les libellés des autres codes ne changent pas.
- [ ] **Step 4 : vérifier.**
  - Relancer les tests, puis tout `src/services/golden` et `src/services/payroll-engine*`. Attendu : PASS.
  - `pnpm --filter api exec tsc --noEmit` propre.
- [ ] **Step 5 :** commit `feat(paie): règle d'ancienneté par pays UEMOA et libellés d'heures supplémentaires dérivés du pack`.

### Task 1b: Correction de la paie ivoirienne (valeurs en vigueur depuis le 01/01/2023)

_Ajoutée le 04/11/2026. Le porteur a choisi « corriger dès la prochaine paie » : les bulletins déjà clôturés ne sont pas modifiés, et chaque client reçoit un rapport d'impact. Sources : `docs/superpowers/specs/2026-11-04-civ-verification-sources.md`._

| Point | Valeur moteur | Valeur en vigueur | Source |
|---|---|---|---|
| Plafond retraite CNPS (`plafondCnpsRetraite`) | 1 647 315 | **3 375 000** (45 × SMIG) | Communiqué CNPS « Nouveau plafond des cotisations sociales » (01/2023), décret n° 2022-986 du 21/12/2022 |
| Plafond AT / PF / maternité (`plafondCnpsAtPf`) | 70 000 | **75 000** (= SMIG) | même communiqué |
| Heures supplémentaires | 15 / 50 nuit-dim / 100 férié | 15 % (41e–46e h) · 50 % (au-delà de 46 h) · 75 % (nuit) · 75 % (dimanche/férié de jour) · 100 % (dimanche/férié de nuit) | décret n° 2024-898 du 16/10/2024, art. 25 (abroge le décret 96-203, mêmes taux) |
| CMU | absente | 1 000 F/mois par bénéficiaire : 500 employeur + 500 salarié (salarié, conjoint sans emploi, jusqu'à 6 enfants de moins de 21 ans) ; au-delà du 6e enfant, 1 000 à la charge du salarié | loi n° 2014-131 ; CLEISS ; servicepublic.gouv.ci |

**Rulings (contrôleur) :**
- **Heures supplémentaires dans le pack CIV.** `overtimeRates` devient `{ weekly: 0.15, weeklyBeyond: 0.5, weeklyBeyondFromHour: 47, night: 0.75, sunday: 0.75, holiday: 0.75, sundayHolidayNight: 1.0 }`. Les champs optionnels sont ajoutés à l'interface, et les autres packs ne changent pas.
- **Éléments variables CIV.** `HEURES_SUPP_NORM` (41e–46e h, +15 %) reste. `HEURES_SUPP_NUIT` devient « nuit +75 % ». `HEURES_SUPP_FERIE` devient « dimanche/férié de nuit +100 % ». Deux clés sont ajoutées : `HEURES_SUPP_47` (au-delà de 46 h, +50 %) et `HEURES_SUPP_DIM` (dimanche/férié de jour, +75 %). Elles sont soumises aux cotisations et à l'impôt comme les autres. Les montants restent saisis par le RH, et les libellés sont dérivés du pack (`overtimeLabels`).
  - Les libellés des règles de paie provisionnées (`db/provisioning.ts` 1780–1782) sont mis à jour pour les **nouveaux** tenants.
  - Pour les tenants existants, une migration lazy met à jour le libellé des règles 1400/1500/1550 **seulement s'il vaut encore exactement le libellé d'origine**. Elle ajoute aussi les règles des deux nouvelles clés si elles sont absentes.
- **CMU.**
  - Le pack CIV reçoit `cmu: { perBeneficiary: 1000, employerShare: 0.5, maxSharedChildren: 6 }`.
  - Bénéficiaires = salarié + conjoint (si `cmu_spouse_covered`) + enfants couverts (`cmu_children_covered`, ou à défaut le nombre d'enfants à charge du salarié).
  - Deux colonnes sont ajoutées sur `employees` : `cmu_spouse_covered boolean NOT NULL DEFAULT false` et `cmu_children_covered integer NULL`, via la migration lazy et le DDL de provisioning. Elles sont modifiables sur la fiche employé (onglet paie), avec i18n FR/EN.
  - Le conjoint n'est pas compté par défaut : un conjoint salarié a sa propre CMU, donc on ne présume pas qu'il est sans emploi.
  - Le moteur ajoute deux lignes :
    - une retenue salariale « CMU » = 500 × bénéficiaires partagés + 1 000 × enfants au-delà de 6 ;
    - une charge patronale « CMU » = 500 × bénéficiaires partagés.
  - Ces lignes ne réduisent ni l'assiette CNPS ni l'assiette ITS.
  - Codes de ligne : prendre les prochains codes libres dans les séries « cotisation salariale » et « cotisation patronale » du moteur, puis les documenter.
- **Plafonds.** Remplacer les valeurs dans `CIV_2024` et partout où le code ou l'UI les répète :
  - `cnps.routes.ts` ;
  - `platform.routes.ts` ;
  - `SettingsPage.tsx` ;
  - `HomePage.tsx` ;
  - `content-west-africa.ts`.
  - Grepper aussi `1 647 315`, `1647315`, `70 000`, `70_000` et `19 767 780`, dans le contexte CNPS uniquement.
- **Documentation.** Mettre à jour `nexusrh_ci/CLAUDE.md` (VALEURS LÉGALES, piège n° 1) et `docs/reference/paie-mobile-money-ia.md` avec les nouvelles valeurs et leurs sources.
- **Fixtures golden.**
  - Recalculer **à la main** chaque fixture touchée. Les 39 fixtures sous `services/golden/fixtures` sont concernées si le brut dépasse 70 000 (assiette AT/PF) ou 1 647 315 (retraite), et toutes le sont par la CMU.
  - Pour chaque fixture modifiée, écrire le détail du recalcul dans le rapport : ancienne valeur, nouvelle valeur, opération.
  - Interdit de régénérer les fixtures depuis le moteur.
- **Rapport d'impact.**
  - Route `GET /payroll/ci-2023-impact`, accès `authorize('admin', 'hr_manager')`, avec export CSV `?format=csv`.
  - Elle parcourt les bulletins **clôturés** depuis le 01/2023 du tenant, pack CIV uniquement. Par bulletin :
    - retraite non cotisée = `max(0, min(brut, 3 375 000) − 1 647 315)` × 6,3 % (part salariale) et × 7,7 % (part patronale) ;
    - AT/PF/maternité patronal manquant = `max(0, min(brut, 75 000) − 70 000)` × (5 % + 0,75 % + taux AT du bulletin) ;
    - CMU non retenue = 500 × bénéficiaires actuels (côté salarié comme côté employeur), signalée comme « estimation (bénéficiaires actuels) » ;
    - drapeau `heures_supp_a_verifier` si le bulletin contient des lignes 1500 ou 1550.
  - Elle renvoie des totaux par salarié et par mois. Elle ne modifie rien.

**Files :**
- `legislation-packs.ts`, `payroll-engine-ci.ts`, `payroll-explainer.service.ts` (textes CIV des lignes concernées).
- `db/provisioning.ts`, `utils/schema-migrations.ts`.
- La fiche employé : route PATCH employé (Zod) et web.
- Le nouveau fichier `modules/payroll/ci-2023-impact.routes.ts`, enregistré dans l'application.
- Les fichiers d'affichage listés ci-dessus.
- `CLAUDE.md` et `docs/reference/paie-mobile-money-ia.md`.
- Tests :
  - les fixtures golden ;
  - `payroll-engine-ci-2023.golden.test.ts`, nouveau, qui couvre :
    - brut 2 000 000 : retraite sur 2 000 000 ;
    - brut 4 000 000 : retraite sur 3 375 000 ;
    - brut 75 000 et brut 72 000 : assiette AT/PF ;
    - CMU : 1 salarié seul ; conjoint + 2 enfants ; 8 enfants ;
  - les tests de la route d'impact, avec 403 pour hr_officer et une vérification qu'aucune écriture n'a lieu.

- [ ] Tests en échec d'abord, puis implémentation.
- [ ] Recalcul manuel des fixtures, puis toute la suite `src/services`, `src/modules/payroll`, `src/modules/cnps` et `tsc` (api et web).
- [ ] Commit : `fix(paie-ci): plafonds CNPS 2023, heures supplémentaires (décret 2024-898) et CMU`.

### Task 2: Routes `/payroll/simulator`

**Files :**
- Create : `apps/api/src/modules/payroll/simulator.routes.ts`
- Modify : l'enregistrement des routes de l'application (là où `payrollRoutes` est enregistré), avec le préfixe `/payroll/simulator`.
- Test : `apps/api/src/modules/payroll/simulator.routes.test.ts`

**Interfaces :**
- Consomme : la tâche 1, plus `calculatePayrollCI`, `explainLines` (`services/payroll-explainer.service.ts`), `getLegislationPack`/`LEGISLATION_PACKS`, `currencyLabel` et l'audit tenant tel qu'utilisé par `POST /payroll/simulate`.
- Produit : `GET /payroll/simulator/countries` et `POST /payroll/simulator/simulate`, avec les formes exactes de la spec (§ API).

**Points fixés :**
- `UEMOA_COUNTRIES = ['CIV','SEN','MLI','BFA','NER','BEN','TGO','GNB']`, dans cet ordre.
- Secteurs AT de la CIV dans les métadonnées : `[{key:'commerce',rate:0.02},{key:'btp',rate:0.03},{key:'industrie',rate:0.04},{key:'extraction',rate:0.05}]`. Les autres pays ont `sectors: null`.
- Le mode famille se déduit du pack :
  - `reductionChargesFamille` présent → `'parts'` ;
  - sinon `reductionImpotPctParCharges` présent → `'percent'` ;
  - sinon `'credits'`.
- `atRate` absent du corps → taux par défaut du pack.
- Si le pack n'a ni `tauxAtMin` ni `tauxAtMax`, seul le taux par défaut est accepté. Toute autre valeur → 400 « Taux AT non paramétrable pour ce pays ».
- La simulation « +1 enfant » relance le moteur avec `childrenCount + 1`.
- `effortRate = arrondi à 0,1 de (cotisations salariales + impôt) / brut × 100`.
- Seuls les pays vérifiés sont simulables, comme le décide le porteur (voir la spec, § Pays). Concrètement :
  - la constante `SIMULATOR_VERIFIED_PACKS = ['CIV-2024']` fixe la liste ;
  - `GET /countries` ajoute `available` et `unavailableReason` à chaque pays ;
  - `POST /simulate` sur un pays absent de la liste répond 409 `{ error: 'Données de paie en cours de vérification pour ce pays' }`.
- La vérification CIV est close et corrigée par la tâche 1b : aucun avertissement CIV n'est ajouté.
- Le simulateur CIV reçoit les heures sur les 5 catégories de la tâche 1b. Il calcule les deux lignes CMU avec un nombre de bénéficiaires saisi : un salarié par défaut, plus un conjoint couvert (case à cocher) et des enfants couverts (par défaut, le nombre d'enfants saisi).
- Le web masque une catégorie d'heures supplémentaires et le bloc CMU lorsque le pack ne les porte pas.
- Tests :
  - 409 pour `SEN` ;
  - `available` vaut false pour les 7 autres pays.

- [ ] **Step 1 : tests en échec** (vraies routes, vrai `authorize`, pool mocké).
  - `countries` : 8 pays dans l'ordre. Le SMIG CIV vaut 75 000, la caisse CIV `CNPS` et celle du SEN `IPRES + CSS`. `transportZones` vaut null pour un pack sans `primeTransportExoneree`. `seniorityBonus` vaut null pour BEN et GNB.
  - Simulation CIV, base 450 000, célibataire, 0 enfant, aucun autre élément, embauche il y a moins de 2 ans : `totals.tax` vaut 70 500.
  - Simulation CIV, embauche il y a 10 ans, minimum de catégorie 150 000 : une ligne `1100` de montant 15 000 apparaît dans `payslip.lines`.
  - Cas 400 :
    - `countryCode: 'FRA'` ;
    - `atRate: 0.09` en CIV ;
    - `transportZone: 'paris'` ;
    - `categoryMinimum` inférieur au SMIG ;
    - `hireDate` postérieure au mois de paie ;
    - heures saisies pour une majoration absente ;
    - champ inconnu (`.strict()`).
  - Rôles manager, employee et readonly → 403.
  - Base 300 000 < minimum de catégorie 350 000 → 200, avec un avertissement.
- [ ] **Step 2 :** FAIL.
- [ ] **Step 3 :** implémenter.
- [ ] **Step 4 :** relancer le fichier, puis `src/modules/payroll`, `src/app.boot.golden.test.ts` et `tsc`. Attendu : PASS.
- [ ] **Step 5 :** commit `feat(paie): API du simulateur de paie multi-pays UEMOA`.

### Task 3: Page web « Simulateur de paie »

**Files :**
- Modify : `apps/web/src/pages/payroll/ItsSimulatorPage.tsx` (réécriture, même export par défaut, même route).
- Modify : les fichiers i18n FR et EN du namespace `payroll`. Les clés `simulator.*` inutilisées sont supprimées, les nouvelles ajoutées.
- Modify : le libellé du menu (`itsSimulator`), qui devient « Simulateur de paie » / « Payroll simulator ».
- Test : `apps/web/src/pages/payroll/ItsSimulatorPage.test.tsx`

**Interfaces :**
- Consomme : les deux routes de la tâche 2.

- [ ] **Step 1 : test en échec** (API mockée).
  - Au chargement, la CIV est sélectionnée. Le libellé `CNPS` et le SMIG de 75 000 sont affichés.
  - Les pays dont `available` vaut false sont grisés dans la liste, avec la mention « Données de paie en cours de vérification ». Ils ne sont pas sélectionnables.
  - Passer au SEN (dans le test, son `available` est mis à true dans le mock, afin de vérifier que l'écran est bien piloté par les métadonnées) :
    - affiche `IPRES + CSS` ;
    - remplace la liste des secteurs AT par un champ numérique ;
    - masque la zone de transport si `transportZones` est null ;
    - efface le résultat.
  - BEN : le champ « prime d'ancienneté » est en saisie manuelle avec la mention « non paramétré ».
  - « Calculer » envoie exactement le corps attendu à `/payroll/simulator/simulate`.
  - La réponse affiche le net, les lignes du bulletin et les avertissements.
- [ ] **Step 2 :** FAIL.
- [ ] **Step 3 :** implémenter.
  - Sections Pays / Emploi / Rémunération / Heures supplémentaires / Famille / Résultat.
  - Toutes les valeurs par défaut viennent des métadonnées.
  - Montants formatés avec `formatFCFA`, ou avec le libellé de devise de l'API si elle n'est pas en XOF.
  - Les erreurs 400 affichent le message de l'API.
- [ ] **Step 4 :** relancer le test, puis `pnpm --filter web exec tsc --noEmit`. Attendu : PASS.
- [ ] **Step 5 :** commit `feat(paie): simulateur de paie multi-pays piloté par les packs`.
