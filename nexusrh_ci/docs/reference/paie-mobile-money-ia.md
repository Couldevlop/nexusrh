# Moteur de paie CI, Mobile Money, Assistant IA — détail

> Référence détaillée. Chargée à la demande depuis `nexusrh_ci/CLAUDE.md`.
> Les valeurs légales chiffrées (const `CI_LEGAL_CONSTANTS_2024`) restent dans le cœur `CLAUDE.md`.

---

## CONFORMITÉ IVOIRIENNE — DÉTAIL EXPLICATIF

### CNPS — Caisse Nationale de Prévoyance Sociale

```
Branche                       Part salariale   Part patronale   Plafond/mois
──────────────────────────────────────────────────────────────────────────────
Retraite                          6,30 %           7,70 %       1 647 315 FCFA
Prestations familiales + Mat.      0,00 %           5,75 %          70 000 FCFA
  dont Allocations familiales      0,00 %           5,00 %
  dont Assurance maternité         0,00 %           0,75 %
Accidents du travail (AT)         0,00 %         2,00–5,00 %        70 000 FCFA

PLAFOND MENSUEL AT/PF/Maternité : 70 000 FCFA (840 000 FCFA/an)
PLAFOND MENSUEL RETRAITE        : 1 647 315 FCFA

Taux AT par secteur :
  Commerce, services, tertiaire   : 2,00 %
  BTP, transports                 : 3,00 %
  Industrie, manufacture          : 4,00 %
  Extraction, mines               : 5,00 %

Date limite déclaration e-CNPS : avant le 15 du mois M+1
```

### ITS — Impôt sur les Traitements et Salaires (réforme 2024)

```
Ordonnance n° 2023-719 du 13/09/2023, en vigueur au 01/01/2024.
L'ITS remplace les anciens IS, CN et IGR. Il s'applique sur 100 % du
revenu brut imposable : AUCUN abattement forfaitaire (l'ancien 15 % est
supprimé) et les cotisations CNPS salariales ne sont PAS déduites.

Barème progressif (tranches mensuelles en FCFA) :

Tranche mensuelle              Taux
──────────────────────────────────────
0 – 75 000                      0 %
75 001 – 240 000               16 %
240 001 – 800 000              21 %
800 001 – 2 400 000            24 %
2 400 001 – 8 000 000          28 %
> 8 000 000                    32 %

Réduction d'impôt pour charges de famille (RICF), imputée sur l'impôt brut :
  Parts   1   1,5    2      2,5    3      3,5    4      4,5    5
  RICF    0   5 500  11 000 16 500 22 000 27 500 33 000 38 500 44 000  (FCFA/mois)
  (5 500 FCFA par demi-part au-delà de 1 part, plafond 5 parts)

Nombre de parts :
  Célibataire / divorcé / veuf sans enfant          : 1
  Marié                                              : 2 (+ 0,5 par enfant à charge)
  Célibataire / divorcé / veuf avec ≥ 1 enfant      : 1,5 + 0,5 par enfant
  Plafond                                            : 5 parts

Exemples (célibataire, 0 enfant) :
  brut 200 000    → (200 000 − 75 000) × 16 %                 =  20 000
  brut 450 000    → 26 400 + (450 000 − 240 000) × 21 %       =  70 500
  brut 1 500 000  → 26 400 + 117 600 + (1 500 000 − 800 000) × 24 % = 312 000
```

### Autres obligations légales CI

```
SMIG mensuel (35h)             : 60 000 FCFA
Congés annuels                 : 2,5 jours ouvrables / mois travaillé
Heures supplémentaires         :
  41–48h / semaine             : +15 % du taux horaire normal
  Nuit (20h–5h) & dimanche     : +50 % du taux horaire normal
  Jours fériés                 : +100 %
Préavis (démission/licenciement) :
  Essai CDI employé            : 15 jours
  Essai CDI cadre              : 1 mois
  CDI ancienneté < 1 an        : 1 mois
  CDI ancienneté 1–5 ans       : 2 mois
  CDI ancienneté > 5 ans       : 3 mois
Maternité                      : 14 semaines (6 avant + 8 après)
Paternité                      : 10 jours
Deuil familial                 : 3 jours (parents, conjoint, enfant)

DISA (Déclaration Individuelle Salaires Annuels) :
  Base légale  : Loi 99-477 du 2 août 1999
  Fréquence    : Annuelle (clôture janvier de l'année N+1)
  Contenu      : NNI, nom, prénom, salaire annuel brut, cotisations, ITS
  Dépôt        : CNPS + DGI
  Sanction     : Amende + intérêts de retard
```

---

## MOTEUR DE PAIE CI — LOGIQUE COMPLÈTE

```
PayrollEngineCi.calculate(ctx) :

ÉTAPE 1 — buildVariables()
  BRUT_MENSUEL = salaire brut mensuel contractuel (FCFA)
  BRUT_PRORATA = BRUT_MENSUEL * (jours_travaillés / jours_ouvrables_mois)
  SMIG = 70_000 FCFA  (vérification plancher)
  PLAFOND_CNPS_AT_PF = 70_000 FCFA / mois
  PLAFOND_CNPS_RETRAITE = 1_647_315 FCFA / mois
  BASE_AT_PF = min(BRUT_PRORATA, PLAFOND_CNPS_AT_PF)
  BASE_RETRAITE = min(BRUT_PRORATA, PLAFOND_CNPS_RETRAITE)
  + variableElements (primes, heures supp majorées, IJSS CNPS si applicable)

ÉTAPE 2 — Calcul cotisations CNPS
  cotisation_retraite_sal  = BASE_RETRAITE × 0.063
  cotisation_retraite_pat  = BASE_RETRAITE × 0.077
  cotisation_pf_mat_pat    = BASE_AT_PF × 0.0575
  cotisation_at_pat        = BASE_AT_PF × taux_at_secteur  (2-5%)
  total_cotisations_sal    = cotisation_retraite_sal
  total_cotisations_pat    = cotisation_retraite_pat + cotisation_pf_mat_pat + cotisation_at_pat

ÉTAPE 3 — Calcul ITS (réforme 2024)
  brut_imposable           = brut soumis à l'ITS (100 %, sans abattement,
                             cotisations CNPS salariales NON déduites)
  its_brut                 = appliquer_bareme_ITS(brut_imposable)   [0/16/21/24/28/32 %]
  parts                    = nombre_de_parts(statut_marital, nb_enfants)  [plafond 5]
  ricf                     = 5 500 × (parts − 1) / 0,5             [0 → 44 000]
  ITS                      = max(0, its_brut - ricf)

ÉTAPE 4 — computeTotals()
  salaire_brut             = BRUT_PRORATA + primes + heures_supp + autres_gains
  total_retenues_sal       = total_cotisations_sal + ITS
  salaire_net              = salaire_brut - total_retenues_sal
  cout_employeur           = salaire_brut + total_cotisations_pat
  VÉRIFICATION             : salaire_net >= SMIG (60 000 FCFA) si temps plein

ÉTAPE 5 — Génération bulletin PDF
  Mentions légales CI obligatoires :
    - Numéro CNPS employeur | Numéro NNI salarié
    - Période de paie | Date de paiement
    - Toutes les rubriques détaillées (gains + retenues)
    - Net à payer en FCFA + mode de paiement (virement / Mobile Money)
    - Cumuls annuels salaire brut / cotisations / ITS
```

### Rubriques de paie CI préconfigurées

```
Code   Libellé                           Type              Formule/Taux
────────────────────────────────────────────────────────────────────────────────
1000   Salaire de base                   earning            BRUT_MENSUEL
1100   Prime d'ancienneté                earning            VAR:PRIME_ANCIENNETE
1200   Prime de rendement                earning            VAR:PRIME_RENDEMENT
1300   Prime de transport                earning            VAR:PRIME_TRANSPORT
1400   Heures supplémentaires (+15%)     earning            VAR:HEURES_SUPP_NORM
1500   Heures supplémentaires (+50%)     earning            VAR:HEURES_SUPP_NUIT
1600   Indemnité de congés payés         earning            VAR:ICP
2000   CNPS Retraite (salarié 6,3%)      employee_contrib   BASE_RETRAITE * 0.063
2100   ITS (Impôt Traitements Salaires)  employee_contrib   ITS
3000   CNPS Retraite (patronal 7,7%)     employer_contrib   BASE_RETRAITE * 0.077
3100   CNPS Prestations familiales 5%    employer_contrib   BASE_AT_PF * 0.050
3200   CNPS Assurance maternité 0,75%    employer_contrib   BASE_AT_PF * 0.0075
3300   CNPS Accidents du travail         employer_contrib   BASE_AT_PF * taux_at
4000   Mutuelle/Assurance santé sal.     employee_contrib   VAR:MUTUELLE_SAL
4100   Mutuelle/Assurance santé pat.     employer_contrib   VAR:MUTUELLE_PAT
5000   Avance sur salaire                deduction          VAR:AVANCE
5100   Retenue absence non justifiée     deduction          VAR:RETENUE_ABSENCE
```

---

## MOBILE MONEY — INTÉGRATION CI

```
Opérateurs supportés :
  Wave          : API REST · /transfer · numéro +225 XXXXXXXX
  MTN MoMo      : USSD *133*166# (pour initiation) + API REST API
  Orange Money  : #144*453# + API Orange Money CI
  COFINA        : API REST partenaire

Table mobile_money_payments :
  id | tenantId | employeeId | amount (FCFA) | currency='XOF'
  provider: wave|mtn_momo|orange_money|cofina|bank_transfer
  phoneNumber | reference | status: pending|success|failed|cancelled
  initiatedAt | confirmedAt | createdAt

Flux de paiement salaire :
  1. Clôture paie → génère les ordres de virement (table mobile_money_payments)
  2. Admin valide la campagne de paiement
  3. API Mobile Money déclenche les transferts (bulk)
  4. Callback webhook → mise à jour status
  5. Notification SMS/WhatsApp envoyée à chaque salarié
  6. Bulletin PDF marqué "payé" avec référence de transaction

Note : En mode offline/réseau limité, la liste des paiements est mise en cache
et synchronisée dès la reconnexion (PWA + Service Worker).
```

---

## ASSISTANT IA — LOGIQUE CALIBRÉE CI

```
streamChat(messages, context) : SSE via anthropic.messages.stream()
  System prompt CI :
    "Tu es un expert RH et droit social ivoirien. Tu connais parfaitement le Code du Travail
     de Côte d'Ivoire, la réglementation CNPS 2024, les barèmes ITS/DGI, le droit OHADA.
     Tu réponds TOUJOURS en français. Tu cites les articles du Code du Travail CI, les
     circulaires CNPS et les textes DGI pertinents. Tes réponses sont adaptées au contexte
     ivoirien (SMIG 60 000 FCFA, FCFA comme devise, Mobile Money, FDFP…).
     Contexte tenant : {name} · {ville} · {secteur} · CCN applicable : {convention}"

Exemples de questions CI :
  "Combien de jours de congés pour 8 mois de travail ?" → 20 jours ouvrables
  "Quel est le taux AT pour une entreprise BTP ?" → 3 %
  "Comment calculer la DISA ?" → guide pas à pas
  "Notre salarié a été absent 5 jours. Impact sur la CNPS ?" → calcul prorata

generateHRDocument(type, data) — Types CI :
  cdi_ci | cdd_ci | contrat_apprentissage | contrat_stage | avenant
  lettre_embauche | avertissement | mise_en_demeure | lettre_licenciement
  rupture_conventionnelle_ci | certificat_travail | attestation_emploi
  attestation_cnps_employeur | reçu_solde_tout_compte

analyzeRetentionRisk(data) — calibré CI :
  Facteurs CI : ancienneté < 18 mois | salaire = SMIG depuis > 6 mois
  | absences maladie > 5j/trimestre | aucune formation depuis > 12 mois
  | score engagement < 3/5 | retard de paiement salaire
  Output : { score, risk: low|medium|high, factors[], recommendations[] }
```
