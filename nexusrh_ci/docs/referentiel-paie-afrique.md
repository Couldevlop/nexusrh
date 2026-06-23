# Référentiel paie multi-pays — UEMOA / CEMAC / Nigeria

> **Source de vérité** des constantes de paie par pays (sécurité sociale, impôt sur les
> salaires, SMIG, règles de congés). Les packs législatifs du moteur
> (`apps/api/src/services/legislation-packs.ts`) **dérivent de ce document**.
>
> **Mise à jour** : ce fichier est conçu pour être rafraîchi périodiquement par une
> **tâche planifiée** (cron) qui re-vérifie chaque valeur auprès des sources officielles,
> met à jour `Dernière vérif.` et signale les écarts. Voir la procédure en fin de document.
>
> **Légende confiance** : 🟢 vérifié (source officielle/PwC/CLEISS en ligne) · 🟡 partiel /
> source secondaire · 🔴 estimation (données pays peu documentées en ligne — à confirmer).
>
> **Dernière campagne de vérification : 2026-06-23.**

---

## ⚠️ Limites du modèle moteur (à lire avant activation)

Le moteur (`PayrollContext` / `LegislationPack`) modélise : 1 cotisation **retraite salarié**,
retraite/PF/maternité/AT **patronales**, un **abattement %** unique, un **barème progressif**
(mensuel ou annuel), des **crédits d'impôt** famille. Il **ne modélise pas encore** :

- **Quotient familial / parts** (Gabon, Congo, Sénégal, Cameroun) — l'impôt y dépend du
  nombre de parts ; ici approximé sans quotient (→ impôt surévalué pour les familles).
- **Cotisation santé distincte** (CNAMGS Gabon, AMU Togo, CNAMGS…) — repliée dans la
  part retraite salarié / PF patronale (le net global reste correct, le détail par ligne non).
- **Surtaxes / prélèvements annexes** : CAC 10 % + CFC + FNE + CRTV (Cameroun), TCTS 5 %
  (Gabon), Taxe Unique sur Salaires 7,5 % (Congo), CRA (Nigeria). Non appliqués.

→ Tant que ces règles ne sont pas implémentées, les packs hors CIV restent **`status: 'stub'`**
(le moteur refuse de calculer) : c'est volontaire pour ne jamais produire un bulletin faux.
L'activation par pays se fait après implémentation des règles fines + validation expert local.

---

## UEMOA (zone XOF)

### Côte d'Ivoire 🟢 — pack `CIV-2024` · **ACTIF**
- **Caisse** : CNPS · **SMIG** : 75 000 FCFA/mois
- **Plafonds** : retraite 1 647 315 · AT/PF 70 000 (double plafond)
- **Cotisations** : retraite sal 6,30 % / pat 7,70 % · PF pat 5,00 % · maternité pat 0,75 % · AT 2-5 % (secteur)
- **Impôt** : ITS, abattement 15 %, barème **mensuel** 0/1,5/5/10/15 % (0-75k / 75k-240k / 240k-800k / 800k-2M / >2M)
- **Crédits** : marié 5 500 ; enfants [3 000, 6 000, 9 000]
- **Congés** : maternité 14 sem. (6+8, CNPS), paternité 10 j, CP 2,5 j/mois, 6 j/sem.
- **Sources** : CNPS CI, DGI CI (impots.gouv.ci), Code du travail CI. Réf. moteur (validé).

### Sénégal 🟡 — pack `SEN-2024` · stub
- **Caisse** : IPRES + CSS · **SMIG** : 64 710 FCFA/mois
- **Plafonds** : IPRES retraite 432 000 · CSS (AT/PF) 63 000
- **Cotisations** : retraite sal 5,60 % / pat 8,40 % · PF/CSS pat 7,00 % · AT ~1 %
- **Impôt** : IR, abattement 30 %, barème **mensuel** 0/20/25/30/35/40 % · **parts familiales** (quotient — non modélisé)
- **Congés** : maternité 14 sem. (CSS), paternité 1 j, CP 2 j/mois, **5 j/sem.** (40h)
- **Sources** : IPRES (ipres.sn), CSS, DGID Sénégal, Code du travail (Loi 97-17). À valider.

### Bénin 🟡 — pack `BEN-2024` · stub
- **Caisse** : CNSS · **SMIG** : 52 000 FCFA/mois · pas de plafond CNSS
- **Cotisations** : retraite sal 3,60 % / pat 6,40 % · PF pat 9,00 % (incl. maternité) · AT 1-4 %
- **Impôt** : ITS (ITS/IRPP), pas d'abattement, barème **mensuel** 0/10/15/19/30 %
- **Congés** : maternité 14 sem. (50 % CNSS + 50 % employeur), paternité 3 j, CP 2 j/mois
- **Sources** : CLEISS Bénin, CGI Bénin 2024 (api.impots.bj), CNSS. **Réforme 2025** a supprimé les déductions familiales. À valider.

### Burkina Faso 🟡 — pack `BFA-2024` · stub
- **Caisse** : CNSS · **SMIG** : 37 500 FCFA/mois · plafond 600 000
- **Cotisations** : retraite sal 5,50 % / pat 5,50 % · PF pat 7,00 % · AT ~3,5 %
- **Impôt** : IUTS, pas d'abattement, barème **mensuel** progressif 0→25 % (7 tranches)
- **Congés** : maternité 14 sem. (4+10, partagé), paternité 3 j, CP 2,5 j/mois
- **Sources** : CNSS Burkina, CGI BF, Code du travail (Loi 028-2008). À valider.

### Togo 🟡 — pack `TGO-2024` · stub
- **Caisse** : CNSS (+ AMU) · **SMIG** : 52 500 FCFA/mois · pas de plafond
- **Cotisations** : retraite sal 9,00 % (4 % vieillesse + 5 % AMU) / pat 17,5 % (12,5 % + 5 %) · PF pat 3,00 % · AT ~2 %
- **Impôt** : IRPP, abattement 28 %, barème **ANNUEL** 0→35 % (8 tranches) ; déduction 10 000/mois/personne (max 6)
- **Congés** : maternité 14 sem. (CNSS), paternité 3 j, CP 2,5 j/mois
- **Sources** : CNSS.tg, CGI Togo, Code du travail. À valider.

### Mali 🟡 — pack `MLI-2024` · stub
- **Caisse** : INPS · **SMIG** : 40 000 FCFA/mois · pas de plafond
- **Cotisations** : retraite sal 3,60 % / pat 5,40 % · PF pat 8,00 % · AT ~2 %
- **Impôt** : ITS, pas d'abattement, barème **mensuel** 0/5/13/30 %
- **Congés** : maternité 14 sem. (INPS), paternité 3 j, CP 2,5 j/mois
- **Sources** : INPS Mali, DGI Mali, Code du travail (Loi 92-020). À valider.

### Niger 🟡 — pack `NER-2024` · stub
- (Valeurs déjà renseignées dans le code, source CNSS Niger / DGI Niger.) À valider.

### Guinée-Bissau 🟡 — pack `GNB-2024` · stub (**NOUVEAU**)
- **Caisse** : INSS (Instituto Nacional de Segurança Social) · **SMIG** : **50 000 FCFA/mois** (décret Conseil des ministres déc. 2024, ex-31 000) · devise XOF
- **Plafond** : **aucun** — cotisations sur le brut intégral (confirmé ISSA/SSA)
- **Cotisations** : INSS salarié **8,00 %** / patronal **14,00 %** · AT pat **2 %** (2-10 % selon classe) · **pas de branche prestations familiales** (particularité vs UEMOA francophone)
- **Prélèvement spécifique** : **Imposto do Selo 0,3 %** sur salaires (timbre)
- **Impôt** : Imposto Profissional (retenue **mensuelle**, base = brut − 8 % SS) — **barème NON RÉSOLU** (sources contradictoires : mensuel 10/20/35 % vs annuel 8/15/20/25 %). Réf. légale : *Código do Imposto Profissional*, Decreto 4/84 art. 27. **À ne pas hardcoder sans le texte.**
- **Congés** : maternité ~60 j (8,5 sem.), CP 30 j/an (≈2,5/mois), **5 j/sem.** (40h)
- **Particularités** : lusophone, IVA (TVA) depuis 01/2025, migration IUR→IRPS
- **Sources** : 🟡 SSA/ISSA (ssa.gov), Britacom *Sistema Fiscal Guineense* (oct. 2025), dn.pt (SMIG), rivermate/papayaglobal (congés). **Pas de fiche CLEISS** (pas d'accord bilatéral FR↔GB). Cotisations + SMIG haute confiance ; **barème impôt à confirmer** sur kontaktu.mef.gw.

---

## CEMAC (zone XAF)

### Cameroun 🟢 — pack `CMR-2024` · stub (**NOUVEAU**)
- **Caisse** : CNPS · **SMIG** : 60 000 FCFA/mois (revalorisé 2023)
- **Plafond** cotisable : **750 000 FCFA/mois**
- **Cotisations** : retraite sal **4,20 %** / pat **4,20 %** · PF pat **7,00 %** · AT **1,75-5 %** (secteur)
- **Impôt** : IRPP, abattement **30 %** (plafonné 400 000/mois), barème **ANNUEL** :
  0-2M **10 %** / 2M-3M **15 %** / 3M-5M **25 %** / >5M **35 %** (seuil retenue 62 000/mois)
- **Surtaxes non modélisées** : CAC 10 % de l'IRPP · CFC 1 % sal + 1,5 % pat · FNE 1 % pat · CRTV/RAV
- **Congés** : maternité 14 sem., CP 1,5 j ouvr./mois (18/an), 6 j/sem.
- **Sources** : 🟢 CNPS Cameroun (cnps.cm), CLEISS Cameroun, DGI/MINFI (impots.cm — Circulaire LF 2024, barème IRPP_DSSI). Confiance haute CNPS+IRPP ; surtaxes à implémenter.

### Gabon 🟢 — pack `GAB-2024` · stub (**NOUVEAU**)
- **Caisse** : CNSS + CNAMGS · **SMIG** : 150 000 FCFA/mois
- **Plafond** cotisable : **1 500 000 FCFA/mois** (18 M/an)
- **Cotisations salarié** : CNSS pension **2,50 %** + CNAMGS santé **2,00 %** = **4,50 %**
- **Cotisations patronales** (total **20,1 %**) : pension 5 % · PF 8 % · AT 3 % · CNAMGS (évac. 0,6 + médic. 2 + hospit. 1,5 = 4,1 %)
- **Impôt** : IRPP, abattement **20 %**, barème **ANNUEL** 0/5/10/15/20/25/30/35 % (0-1,5M … >11M) · **quotient familial 1-4,5 parts** (non modélisé)
- **Surtaxe non modélisée** : TCTS 5 % (exonéré < 150 000/mois)
- **Congés** : maternité 14 sem. (6 avant), CP, 6 j/sem.
- **Sources** : 🟢 PwC Tax Summaries Gabon (income + other-taxes), CLEISS Gabon. Confiance haute taux ; quotient + TCTS à implémenter.

### Congo (Brazzaville) 🟡 — pack `COG-2024` · stub (**NOUVEAU**)
- **Caisse** : CNSS · **SMIG** : ~90 000 FCFA/mois (à confirmer)
- **Plafond** cotisable : **~1 200 000 FCFA/mois** (≈ 14,4 M/an, soit 21 952,65 €/an)
- **Cotisations salarié** : CNSS retraite **4,00 %**
- **Cotisations patronales** (estimation) : retraite ~8 % · PF ~10,03 % · AT ~2,25 %
- **Impôt** : IRPP, abattement 20 %, barème **ANNUEL** 1/10/25/40 % (0-464k / 464k-1M / 1M-3M / >3M)
- **Prélèvement spécifique** : **Taxe Unique sur les Salaires 7,5 %** (remplace forfait/apprentissage/logement/emploi)
- **Congés** : maternité **15 sem.** (6+9, indemnité 50 % salaire mois précédent), CP
- **Sources** : 🟡 PwC Tax Summaries Congo (income + other-taxes), CLEISS Congo. Patronal + abattement à confirmer (CNSS.cg).

### Tchad 🟡 — pack `TCD-2024` · stub
- (Valeurs déjà dans le code, devise XAF, CNPS Tchad / DGI Tchad.) À valider.

### Centrafrique 🔴 — pack `CAF-2024` · stub (**NOUVEAU**)
- **Caisse** : CNSS (OCSS) · **SMIG** : ~35 000 FCFA/mois (à confirmer) · devise XAF
- **Cotisations** (estimation CEMAC) : retraite sal ~3 % / pat ~7 % · PF pat ~6 % · AT ~3 %
- **Impôt** : IRPP, barème à confirmer
- **Sources** : 🔴 **Quasi aucune donnée en ligne** (CNSS RCA couvre < 2 % de la population).
  Valeurs = estimation régionale CEMAC. **NE PAS activer sans source officielle.**

### Guinée équatoriale 🟡 — pack `GNQ-2024` · stub (**NOUVEAU**)
- **Caisse** : INSESO · **SMIG** : ~128 000 FCFA/mois (à confirmer) · devise XAF · doc **espagnole**
- **Cotisations salarié** : INSESO **4,50 %** + Fondo Protección Laboral (WPF) **0,50 %** = **5,00 %**
- **Cotisations patronales** : INSESO **21,50 %** + WPF **1,00 %**
- **Impôt** : IRPF, barème **ANNUEL** 0/10/15/20/25 % (0-1,4M / 1,4M-5M / 5M-10M / 10M-15M / >15M)
- **Sources** : 🟡 PwC Tax Summaries Equatorial Guinea (IRPF vérifié). Taux INSESO/WPF de sources secondaires (à confirmer INSESO).

---

## Hors zone franc

### Nigeria 🟡 — pack `NGA-2024` · stub
- **Caisse** : PenCom / NHF · **SMIG** : 70 000 NGN/mois (eff. 01/05/2024) · devise NGN
- **Cotisations** : pension sal 8 % / pat 10 % · NHF 2,5 % · AT (ECS) ~1 %
- **Impôt** : PAYE, barème **ANNUEL** 7/11/15/19/21/24 % · CRA (200 000 + 20 % brut) non modélisée
- **Réforme** : NTA 2025 → barème plus progressif applicable 2026 (futur pack `NGA-2026`)
- **Sources** : PwC Tax Summaries Nigeria, FIRS, PenCom, Labour Act CAP L1. À valider.

---

## Procédure de mise à jour (tâche planifiée)

**Objectif** : maintenir ce référentiel et les packs synchronisés avec les textes officiels
(lois de finances annuelles, décrets de revalorisation SMIG/plafonds, circulaires DGI/caisses).

**Cadence recommandée** : trimestrielle, + une passe obligatoire **en janvier** (lois de finances
de l'année N entrent en vigueur).

**Étapes de la tâche** (à exécuter par un agent avec accès web) :
1. Pour chaque pays, re-vérifier auprès des sources listées (CLEISS, PwC Worldwide Tax Summaries,
   sites des caisses nationales et DGI, codes du travail) : SMIG, plafonds, taux de cotisation,
   barème d'impôt, abattement, règles de congés.
2. Comparer avec les valeurs courantes (ce fichier + `legislation-packs.ts`).
3. En cas d'écart : mettre à jour la valeur, la date `Dernière vérif.`, et **journaliser le changement**
   (ancienne → nouvelle valeur + source) dans une section « Historique » en bas.
4. Passer un pack en `status: 'active'` **uniquement** après : (a) valeurs confirmées par source
   officielle 🟢, (b) règles fines du pays implémentées (quotient familial, santé, surtaxes),
   (c) validation par un expert paie local.

**Note technique** : les valeurs de ce fichier sont la référence humaine. Une évolution possible
est d'externaliser les packs dans un JSON (`legislation-referentiel.json`) lu au démarrage, que
la tâche planifiée met à jour directement — supprimant la double saisie code/doc.

---

## Historique des révisions

| Date | Pays | Champ | Ancien → Nouveau | Source |
|------|------|-------|------------------|--------|
| 2026-06-23 | CMR, GAB, COG, CAF, GNQ, GNB | (création) | — | CNPS.cm, PwC, CLEISS, impots.cm |
