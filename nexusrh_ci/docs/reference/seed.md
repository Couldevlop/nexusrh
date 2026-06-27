# Seed — Données complètes CI

> Référence détaillée. Chargée à la demande depuis `nexusrh_ci/CLAUDE.md`.

**Règle absolue : après `db:seed`, toute l'application fonctionne sans erreur.**
**Toutes les listes affichent des données. Zéro écran vide.**

### Compte super_admin (schema platform)

```
Email    : superadmin@nexusrh-ci.com
Password : SuperAdmin1234!
```

> ⚠️ Seedé avec `ON CONFLICT DO NOTHING` : en PROD le mot de passe a été changé et survit
> aux re-seeds. `SuperAdmin1234!` ne fonctionne que sur une base neuve.

### Tenant 1 — SOTRA (Société de Transport Abidjanais)

```
slug        : sotra | schema : tenant_sotra
Secteur     : Transport | Taux AT CNPS : 3,00 %
Ville       : Abidjan (Treichville)
Plan        : business | status : active
Convention  : Transport urbain CI
primaryColor : #E85D04 | secondaryColor : #F48C06
Logo        : SVG initiales "ST"
CNPS employeur : CI-00123456-X
DGI         : CI-DGI-7890
RCCM        : CI-ABJ-2005-B-123456

Utilisateurs tenant :
  admin@sotra.ci    / Admin1234!  → admin
  rh@sotra.ci       / Admin1234!  → hr_manager
  chef.perso@sotra.ci / Admin1234!  → hr_officer
  manager@sotra.ci  / Admin1234!  → manager (département Exploitation)
  employe@sotra.ci  / Admin1234!  → employee (lié à "Kouassi Jean-Paul")
  dg@sotra.ci       / Admin1234!  → dg

80 employés (noms ivoiriens réalistes) :
  Exploitation    : 35 (chauffeurs, contrôleurs, chefs de ligne)
  Maintenance     : 15 (mécaniciens, électriciens, techniciens)
  Administration  : 15 (RH, comptabilité, juridique, informatique)
  Direction       : 5 (DG, DAF, DRH, Chef exploitation, Chef maintenance)
  Agents terrain  : 10 (guichetiers, agents sécurité)

Salaires selon poste (FCFA brut mensuel) :
  Chauffeur junior       : 150 000 – 200 000 FCFA
  Chauffeur confirmé     : 200 000 – 280 000 FCFA
  Contrôleur             : 120 000 – 180 000 FCFA
  Technicien             : 200 000 – 350 000 FCFA
  Cadre administratif    : 400 000 – 800 000 FCFA
  Cadre supérieur / DRH  : 800 000 – 1 500 000 FCFA

Mobile Money enregistré par employé :
  50 % Wave · 30 % MTN MoMo · 20 % Orange Money (numéros CI fictifs cohérents)

payrollRules : 16 rubriques CI préconfigurées (voir paie-mobile-money-ia.md)
payPeriods : 6 mois (juil–déc 2024), status = "closed"
paySlips : 80 employés × 6 mois = 480 bulletins, status = "generated"
  → netPayable calculé selon moteur CI (CNPS + ITS) pour chaque employé
  → Vérification SMIG 60 000 FCFA respectée pour tous

cnps_declarations : 6 déclarations mensuelles générées (juil–déc 2024)
  → Export e-CNPS CSV généré pour chaque mois
disa_records : DISA 2024 générée pour les 80 employés

absenceTypes : CP | Maladie | Maternité | Paternité | Deuil familial | Sans solde | Formation
absenceBalances pour tous (cohérents : 2,5j/mois × ancienneté)
absences : historique 12 mois, mix statuts
  → Kouassi Jean-Paul (employe@) : 2 approuvées + 1 en attente + 1 rejetée

expense_reports pour Kouassi Jean-Paul :
  3 notes (1 approuvée avec paiement Mobile Money, 1 soumise, 1 brouillon)
  Brouillon : 2 lignes (repas 8 500 FCFA + taxi 3 500 FCFA)

trainings : 10 formations catalogue (dont 4 agréées FDFP)
  (Sécurité routière, RGPD CI/ARTCI, Leadership, Excel, Gestion RH, …)
training_sessions : 5 sessions planifiées
training_enrollments : Kouassi inscrit à 2 formations

recruitment_jobs : 3 offres actives (Chauffeur senior, Technicien auto, RH officer)
applications : 12 candidatures (pipeline kanban)

career_skills : 12 compétences (techniques transport + soft skills)
employee_skills : 8 compétences par employé
evaluations : 1 entretien annuel 2024 par employé (modèle CI)

hr_events : embauche + au moins 1 événement (promotion/augmentation) par employé

mobile_money_payments :
  Campagne décembre 2024 : 80 virements
  → 40 Wave (success) + 24 MTN (success) + 14 Orange (success) + 2 (failed)
```

### Tenant 2 — Cabinet Expertise CI SARL (validation isolation)

```
slug        : cabinet-expertise | schema : tenant_cabinet_expertise
Secteur     : Services (audit, conseil) | Taux AT CNPS : 2,00 %
Ville       : Abidjan (Plateau)
Plan        : starter | status : active
primaryColor : #1D4ED8 | logo : initiales "CE"

Utilisateurs :
  admin@cabinet-expertise.ci  / Admin1234!  → admin
  employe2@cabinet-expertise.ci / Admin1234! → employee

25 employés (auditeurs, comptables, juristes, assistants)
3 mois de bulletins CI complets
Données absences, formations, frais : minimales mais fonctionnelles
```
