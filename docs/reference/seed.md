# Seed — Données complètes et fonctionnelles

> Référence détaillée. Chargée à la demande depuis `CLAUDE.md`.

**Règle absolue : après `db:seed`, toute l'application doit fonctionner sans erreur.**
**Toutes les listes doivent afficher des données. Zéro écran vide.**

### Compte super_admin (schema platform)

```
Email    : superadmin@nexusrh.com
Password : SuperAdmin1234!
```

### Tenant 1 — TechCorp SAS

```
slug     : techcorp | schema : tenant_techcorp
CCN      : SYNTEC | plan : pro | status : active
primaryColor : #4F46E5 | secondaryColor : #818CF8
Logo     : SVG initiales "TC" généré inline (pas d'URL externe)
Sites    : Paris (siège), Lyon, Bordeaux
Depts    : Engineering (20), Product (8), Marketing (7), Sales (10), Finance (5)

Utilisateurs tenant :
  admin@techcorp.com       / Admin1234!  → admin
  rh@techcorp.com          / Admin1234!  → hr_manager
  manager@techcorp.com     / Admin1234!  → manager (dept Engineering, lié à un employé)
  employe@techcorp.com     / Admin1234!  → employee (lié à l'employé "Alice Martin")

50 employés (noms réalistes, mix genres et origines) :
  Engineering : 20 (Dev, Lead, Arch, QA, DevOps)
  Product : 8 (PM, PO, Designer, UX)
  Marketing : 7 (Digital, Content, Brand)
  Sales : 10 (Commercial, Account, SDR)
  Finance : 5 (Comptable, Contrôleur, DAF)
  Salaires selon poste : Junior 32–40k, Confirmé 42–58k, Senior/Lead 60–80k
  Photos : générées (initiales colorées aléatoires, pas d'URL externe)

payrollRules (rubriques SYNTEC standard, 20 rubriques) :
  1000 - Salaire de base (earning, formula: BRUT)
  2000 - Congés payés (earning, formula: VAR:CONGES_PAYES)
  3000 - IJSS (deduction, formula: VAR:IJSS si applicable)
  4100 - CSG déductible (employee_contribution, rate: 0.0680, base: BRUT*0.9825)
  4110 - CSG non déductible (employee_contribution, rate: 0.0240, base: BRUT*0.9825)
  4120 - CRDS (employee_contribution, rate: 0.0050, base: BRUT*0.9825)
  4200 - Maladie salarié (employee_contribution, rate: 0.0000) [supprimée 2018]
  4210 - Maladie employeur (employer_contribution, rate: 0.0700)
  4300 - Alloc. familiales (employer_contribution, rate: 0.0345)
  4400 - AT/MP (employer_contribution, rate: 0.0222)
  4500 - Vieillesse plafonnée sal. (employee_contribution, rate: 0.0690, ceiling: 1)
  4510 - Vieillesse plafonnée pat. (employer_contribution, rate: 0.0855, ceiling: 1)
  4520 - Vieillesse déplafonnée sal. (employee_contribution, rate: 0.0040)
  4530 - Vieillesse déplafonnée pat. (employer_contribution, rate: 0.0175)
  4600 - AGIRC-ARRCO T1 sal. (employee_contribution, rate: 0.0315, ceiling: 1)
  4610 - AGIRC-ARRCO T1 pat. (employer_contribution, rate: 0.0472, ceiling: 1)
  4620 - AGIRC-ARRCO T2 sal. (employee_contribution, rate: 0.0864, base: TRANCHE_B)
  4630 - AGIRC-ARRCO T2 pat. (employer_contribution, rate: 0.1295, base: TRANCHE_B)
  5000 - Mutuelle sal. (employee_contribution, formula: 45)
  5010 - Mutuelle pat. (employer_contribution, formula: 90)

payPeriods : 6 périodes (juil–déc 2024), toutes status = "closed"
paySlips : 50 employés × 6 mois = 300 bulletins, status = "generated"
  → netPayable calculé correctement par le moteur pour chaque employé

absenceTypes : CP | RTT | Maladie | Maternité | Paternité | Événement familial | Sans solde
absenceBalances pour tous les 50 employés (cohérents : acquired ≥ taken + pending)
absences historique 12 mois, mix statuts
  → Alice Martin (employe@) : 2 absences approuvées + 1 en attente + 1 rejetée

expenses pour Alice Martin : 3 notes (1 approuvée, 1 soumise, 1 brouillon)
  Brouillon : 2 lignes (repas 23€ + taxi 15€)

trainings catalogue : 15 formations
  (React Avancé, Leadership, Excel, RGPD, PowerBI, Gestion de projet, etc.)
training_sessions : 8 sessions planifiées (dates futures)
training_enrollments : Alice inscrite à 2 formations

recruitment_jobs : 5 offres actives
applications : 20 candidatures (réparties en pipeline)

career_skills : 15 compétences dans le référentiel
employee_skills : 10 compétences par employé avec niveaux
evaluations : 1 entretien annuel 2024 par employé

hr_events : embauche + au moins 1 événement (promotion/augmentation) par employé
```

### Tenant 2 — Artisan Pro SARL (validation isolation multi-tenant)

```
slug     : artisanpro | schema : tenant_artisanpro
CCN      : Bâtiment | plan : starter
primaryColor : #16A34A | logo : initiales "AP"
Depts    : Chantiers (15), Administration (3)

Utilisateurs :
  admin@artisanpro.com     / Admin1234!  → admin
  employe2@artisanpro.com  / Admin1234!  → employee

18 employés (noms réalistes BTP)
3 mois de bulletins
absences, formations, frais : données minimales mais fonctionnelles
```
