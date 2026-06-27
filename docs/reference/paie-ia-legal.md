# Moteur de paie, Assistant IA, Constantes légales France 2024

> Référence détaillée. Chargée à la demande depuis `CLAUDE.md`.

---

## MOTEUR DE PAIE — LOGIQUE

```
PayrollEngine.calculate(ctx) :
1. buildVariables → BRUT, BRUT_PRORATA, ETP, PLAFOND_SS, TRANCHE_A, TRANCHE_B, SMIC
   + expansion variableElements par ruleCode + JOURS_ABSENCE, HEURES_SUPP
2. Pour chaque rule (triée par order, filtrée par ruleApplies) :
   - Évaluer formula (whitelist [A-Z0-9_\s\+\-\*\/\.\(\)]+)
   - Préfixe "VAR:CODE" = lire élément variable directement
   - Exposer résultat dans vars pour règles suivantes
3. computeTotals :
   grossSalary = Σ earning
   netBeforeTax = grossSalary + Σ (deduction + employee_contribution) [négatifs]
   employerCost = grossSalary + Σ employerAmount
   netPayable = netBeforeTax (incomeTax = 0, PAS via DSN ultérieurement)
4. Résultat : { lines[], grossSalary, netBeforeTax, incomeTax, netPayable, employerCost, workingDays }
```

> ⚠️ Piège : `safeEval` n'injecte que les variables calculées (BRUT, TRANCHE_A…), **PAS les taux**. Les formules doivent embarquer le taux numériquement (`BASE * 0.068`, pas `BASE * RATE`). Voir pièges dans `CLAUDE.md`.

---

## ASSISTANT IA — LOGIQUE

```
streamChat(messages, context) : SSE via anthropic.messages.stream()
  System = expert RH France + contexte tenant (nom, CCN, user courant, page active)
  Réponse toujours en français + références légales (articles CT, CSS)

generateHRDocument(type, data) :
  Types : cdi | cdd | internship | job_offer | warning | termination
          | conventional_termination | certificate | amendment
  Output : Markdown complet, mentions légales, 0 placeholder

analyzeRetentionRisk(data) → { score, risk: low|medium|high, factors[], recommendations[] }
  Worker nocturne met à jour employees.retentionScore + burnoutRisk
```

---

## CONSTANTES LÉGALES FRANCE 2024

```
SMIC mensuel 35h    : 1 766,92 €      Plafond SS mensuel : 3 864 €
CSG déductible      : 6,80 %          CSG non déductible : 2,40 %     CRDS : 0,50 %
Maladie patronale   : 13,00 % (<10)   ou 7,00 % (≥10 salariés)
Alloc. familiales   : 3,45 % (≤3,5x SMIC) | 5,25 % (>3,5x SMIC)
AT/MP               : variable (seed : 2,22 %)
Retraite base       : sal 6,90 % TA | pat 8,55 % TA
AGIRC-ARRCO T1      : sal 3,15 % + pat 4,72 %
AGIRC-ARRCO T2      : sal 8,64 % + pat 12,95 %
RGPD                : NIR + IBAN AES-256 | bulletins 50 ans | dossier 5 ans post-départ
CDD                 : 18 mois max, 2 renouvellements, délai carence 1/3 durée
Essai CDI           : 2 mois employé | 3 mois cadre (renouvelable 1x)
DSN                 : avant le 5 M+1 (≥50 sal) | 15 M+1 (<50 sal)
```
