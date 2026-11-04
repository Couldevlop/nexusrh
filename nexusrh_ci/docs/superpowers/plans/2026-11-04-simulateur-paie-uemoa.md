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
- Les fixtures golden existantes du moteur (`apps/api/src/services/golden`) restent vertes, et les libellés CI du bulletin sont inchangés.
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
5. **Libellés d'heures supplémentaires CIV.** Strictement identiques à l'existant (golden en tâche 1).

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
  - Passer au SEN :
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
