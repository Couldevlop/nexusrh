# Simulateur de paie UEMOA — conception

_Validé par le porteur le 04/11/2026 : « oui je valide mais je veux qu'il ait un vrai moteur derrière cette fonctionnalité. Quand on choisit le pays, les métadonnées se positionnent, surtout pas d'erreurs, tout doit être juste et cohérent »._

## Intention

L'actuel « Simulateur ITS » (`/payroll/simulateur-its`) présente trois limites :

- il ne connaît que la Côte d'Ivoire ;
- il ne prend que 5 champs, dont les primes regroupées en un seul montant ;
- il recalcule dans le navigateur des détails CNPS avec des taux ivoiriens écrits en dur.

Le nouveau simulateur repose entièrement sur le moteur de paie (`calculatePayrollCI` + packs législatifs). Le choix d'un pays charge ses métadonnées depuis l'API : devise, SMIG, caisse, impôt, taux AT, zones de transport, majorations d'heures supplémentaires et règle d'ancienneté. Ensuite, chaque montant affiché vient du serveur.

## Principes non négociables

1. **Une seule source de vérité : les packs.** Le web n'écrit aucun taux, plafond ni barème. Tout vient de `GET /payroll/simulator/countries`.
2. **Aucune valeur inventée.**
   - Une donnée absente d'un pack ne reçoit pas de valeur par défaut. Le champ passe en saisie manuelle, avec une mention « non paramétré pour ce pays ».
   - Une règle à la source incertaine est calculée, mais affichée « règle à confirmer » avec sa référence.
3. **Cohérence garantie par le serveur.** L'API rejette en 400, avec un message précis en français, toute entrée incohérente avec le pays :
   - taux AT hors des bornes du pack ;
   - zone de transport inconnue ;
   - date d'embauche postérieure au mois de paie ;
   - minimum de catégorie inférieur au SMIG ;
   - montants négatifs.
4. **Montants en entiers** dans la devise du pack (FCFA pour l'UEMOA). Aucune décimale.
5. **Côte d'Ivoire inchangée.** Les fixtures golden du moteur restent vertes, et les libellés CI du bulletin ne changent pas.

## Pays

Les 8 pays de l'UEMOA, avec leurs packs actifs : CIV_2024, SEN_2024, MLI_2024, BFA_2024, NER_2024, BEN_2024, TGO_2024, GNB_2024. La Côte d'Ivoire est sélectionnée par défaut.

Un audit des valeurs des packs, comparées aux sources officielles, est mené à part. Ses corrections ne seront appliquées qu'**après validation du porteur**, dans un lot distinct.

**Décision du porteur (04/11, après l'audit) : on bloque les pays non vérifiés.** Seuls les pays dont le pack a été vérifié sur les textes officiels sont simulables.

- La liste vit dans le code serveur : `SIMULATOR_VERIFIED_PACKS` dans `simulator.routes.ts`, qui ne contient au départ que `CIV-2024`. Un pays y entre une fois ses corrections faites et validées.
- `GET /countries` renvoie les 8 pays. Chacun porte `available: boolean` et, s'il n'est pas disponible, `unavailableReason: 'Données de paie en cours de vérification'`.
- `POST /simulate` sur un pays non disponible répond **409**, avec ce même message.
- Le web affiche les pays non disponibles comme grisés, avec la mention.

L'audit (`uemoa-packs-audit.md`) a relevé des écarts dans tous les packs hors CIV : barème annuel et quotient familial au Sénégal, plafonds et SMIG 2026 au Niger, assiette de l'ITS au Bénin, réduction familiale au Togo, AMU au Burkina et AMO au Mali absentes, Guinée-Bissau non vérifiée. Pour la CIV, deux points restent à vérifier sur les textes officiels : le plafond retraite CNPS (3 375 000 depuis 2025 ?) et les majorations d'heures supplémentaires (décret 96-203). Tant que ces deux points ne sont pas confirmés, la CIV reste disponible, mais le résultat porte un avertissement sur les salaires au-dessus de 1 647 315 et sur les heures supplémentaires.

## Prime d'ancienneté — nouveau champ de pack `seniorityBonus`

```ts
interface SeniorityBonusRule {
  /** Paliers ordonnés : à partir de `years` années révolues, taux `rate`. */
  steps: ReadonlyArray<{ years: number; rate: number }>
  /** Taux ajouté par année révolue au-delà du dernier palier. */
  incrementPerYear: number
  /** Taux maximal (null = aucun plafond trouvé dans le texte). */
  maxRate: number | null
  /** Assiette : minimum de la catégorie, ou salaire de base réel. */
  base: 'category_minimum' | 'base_salary'
  /** Texte légal (article, date). */
  source: string
  /** confirmed = texte vérifié ; to_confirm = source secondaire ou ambiguë. */
  confidence: 'confirmed' | 'to_confirm'
}
// LegislationPack.seniorityBonus?: SeniorityBonusRule  (absent = pas de calcul auto)
```

Calcul : `years` est le nombre d'années révolues entre la date d'embauche et le dernier jour du mois de paie.

- Avant le premier palier, le taux vaut 0.
- Sinon, on part du taux du dernier palier atteint, puis on ajoute `incrementPerYear × (years − années de ce palier)`, uniquement si ce palier est le dernier de la liste.
- Le résultat est plafonné à `maxRate`.

Le montant de la prime vaut `arrondi(taux × assiette)`.

| Pack | steps | incr. | max | base | confidence | source |
|---|---|---|---|---|---|---|
| CIV | 2 ans → 2 % | 1 % | 25 % | category_minimum | confirmed | CCI du 19/07/1977, art. 55 (Cour suprême, arrêt n° 351 du 15/06/2006) |
| SEN | 2 → 2 % | 1 % | 25 % | category_minimum | to_confirm | CCNI, art. 45 (cité par des arrêts de la Cour suprême ; vérifier la CCNI de 2019) |
| MLI | 3 → 3 %, 5 → 5 % | 1 % | 15 % | category_minimum | confirmed | Code du travail, art. 97 (loi 2017-21) |
| NER | 3 → 3 % | 1 % | 24 % | category_minimum | to_confirm | CCI du 15/12/1972, art. 47a (maintien sous le Code de 2012 non confirmé) |
| BFA | 3 → 5 % | 1 % | null | base_salary | to_confirm | Décret 2010-810 du 31/12/2010, art. 5 (source secondaire) |
| TGO | 2 → 2 %, 4 → 3 % | 1 % | 30 % | category_minimum | to_confirm | CCI du Togo, art. 36 (3e année ambiguë) |
| BEN | — (absent) | | | | | CCGT du 30/12/2005, art. 65 : assiette et plafond ambigus → saisie manuelle |
| GNB | — (absent) | | | | | aucune source fiable → saisie manuelle |

Quand le pack n'a pas de règle, le simulateur demande le montant de la prime et affiche « règle non paramétrée pour ce pays ».

Une saisie manuelle « montant plus favorable (accord d'entreprise) » remplace toujours le calcul automatique. Le résultat indique alors `source: 'manual'`.

**Ruling (contrôleur) :** les règles `to_confirm` sont calculées mais signalées à l'écran. Les ambiguës (BEN) et celles sans source (GNB) ne sont pas calculées.

## Heures supplémentaires

Les majorations viennent de `pack.leaveRules.overtimeRates` (`weekly`, `night`, `sunday`, `holiday`). Le simulateur reçoit des **heures**, pas des montants.

- Le taux horaire vaut `salaire de base ÷ (heures hebdomadaires × 52 ÷ 12)`. Les heures hebdomadaires par défaut sont 40, modifiables entre 1 et 60.
- Montant d'une catégorie d'heures = `arrondi(heures × taux horaire × (1 + majoration))`.

Correspondance avec les éléments du moteur :

| Heures saisies | Élément moteur |
|---|---|
| Normales (`weekly`) | `HEURES_SUPP_NORM` |
| Nuit + dimanche | somme dans `HEURES_SUPP_NUIT` |
| Jour férié | `HEURES_SUPP_FERIE` |

Si une majoration est absente du pack, le champ d'heures de cette catégorie est désactivé, avec la mention « non paramétré ».

Les libellés de ces lignes dans le moteur deviennent **dérivés du pack**. Le pack CIV doit produire exactement les libellés actuels (`Heures supp. +15%`, `Heures supp. +50% (nuit/dim)`, `Heures supp. +100% (jour férié)`). Pour un autre pays, les pourcentages affichés sont ceux du pack. Si la nuit et le dimanche ont des majorations différentes, le libellé devient `Heures supp. nuit (+X%) / dimanche (+Y%)`.

## Autres éléments

- **Prime de transport.** Le pack fournit la zone (`primeTransportExoneree.parZone`) et le plafond par défaut. La liste des zones est donnée par l'API.
  - Si le pack n'a pas de plafond, l'écran affiche la règle du moteur, à savoir l'exonération totale, avec la mention « aucun plafond paramétré pour ce pays ».
- **Autres primes.** Prime de rendement, prime de panier, gratification et avantage en nature sont soumis selon le traitement du pack.
- **Frais remboursés.** Ils sont transmis par `expenseReimbursement`, hors brut.
- **Famille.** Situation matrimoniale et nombre d'enfants. Le pack applique ses propres règles (parts, crédits ou pourcentage). La comparaison « +1 enfant » est conservée.
- **Taux AT.**
  - Pour la Côte d'Ivoire, liste des secteurs commerce 2 %, BTP 3 %, industrie 4 %, extraction 5 %. Ces secteurs sont dans les métadonnées CIV, pas dans le web.
  - Pour les autres pays, saisie numérique bornée par `tauxAtMin`/`tauxAtMax`, avec par défaut `tauxAtDefaultPatronal`. Sans bornes dans le pack, le taux par défaut est figé, avec la mention correspondante.
- **Catégorie.** Libellé libre et « salaire minimum de la catégorie » (≥ SMIG, prérempli au SMIG du pays). Ce minimum sert d'assiette à l'ancienneté quand `base = category_minimum`.
  - Si le salaire de base est inférieur au minimum de la catégorie, le résultat porte un **avertissement**, pas une erreur.
  - Les grilles légales par catégorie ne sont pas embarquées : aucune grille complète n'a été vérifiée. Un chantier ultérieur ajoutera des grilles par tenant.
- **Niveau d'étude.** **Ruling (contrôleur) :** pas dans le simulateur. Il n'a aucun effet légal sur le calcul, seulement sur le classement dans une catégorie. Sans grille embarquée, ce champ serait décoratif, donc trompeur. Il reviendra avec les grilles de catégories.

## API

Nouveau fichier `apps/api/src/modules/payroll/simulator.routes.ts`, enregistré sous le préfixe `/payroll/simulator`. Accès réservé à `authorize('admin', 'hr_manager', 'hr_officer')`, avec rate limit.

- `GET /countries` renvoie `{ data: CountryMeta[] }`, dérivé des packs UEMOA :
  - `countryCode`, `packCode`, `name`, `currency`, `currencyLabel`, `smigMensuel` ;
  - `labelCaisseSociale`, `labelImpotSalaire`, `workingDaysPerWeek` ;
  - `at: { default, min, max, sectors?: {key, rate}[] }` ;
  - `transportZones: { key, ceiling }[] | null`, `transportDefaultCeiling: number | null` ;
  - `overtimeRates: { weekly?, night?, sunday?, holiday? }` ;
  - `seniorityBonus: SeniorityBonusRule | null` ;
  - `family: { mode: 'parts' | 'credits' | 'percent' }`, ainsi que `familyMaxParts` quand il s'applique ;
  - `sources` (notes du pack).
- `POST /simulate` (corps Zod `.strict()`) :
  - Champs reçus :
    - `countryCode`, `payMonth` (`YYYY-MM`, défaut : mois courant) ;
    - `hireDate` ;
    - `categoryLabel?`, `categoryMinimum` ;
    - `baseSalary`, `weeklyHours` ;
    - `atRate`, `transportZone?` ;
    - `primeTransport`, `primeRendement`, `primePanier`, `gratification`, `avantageNature`, `fraisRembourses` ;
    - `overtimeHours: { weekly, night, sunday, holiday }` ;
    - `seniorityBonusOverride?` ;
    - `maritalStatus`, `childrenCount`.
  - Réponse :
    - `seniority: { years, months, rate, base, amount, source: 'rule'|'manual'|'none', confidence, legalSource }` ;
    - `overtime: [{ kind, hours, hourlyRate, majoration, amount }]` ;
    - `payslip`, le résultat du moteur avec ses lignes expliquées (`explainLines`) ;
    - `totals: { gross, socialEmployee, socialEmployer, tax, net, employerCost, effortRate }` ;
    - `warnings: string[]` (sous le SMIG, sous le minimum de catégorie, règle à confirmer…) ;
    - `plusOneChild: { tax, net, gain }`.
  - Le calcul est délégué à `calculatePayrollCI` avec `legislationPack`, `transportZone` et `variableElements`. Rien n'est persisté. Un audit `payroll.simulated` est écrit, comme pour la simulation existante.
- `POST /ai/simulate-its` est conservé, car il a d'autres appelants. Le web cesse de l'utiliser.

## Web

Réécriture de `apps/web/src/pages/payroll/ItsSimulatorPage.tsx`, titre « Simulateur de paie », même route et même menu. Les sections sont : **Pays**, **Emploi**, **Rémunération**, **Heures supplémentaires**, **Famille**, **Résultat**.

- Chaque champ dépend des métadonnées du pays.
- Changer de pays recharge les valeurs par défaut (SMIG, taux AT, zone) et efface le résultat.
- Le résultat montre :
  - les indicateurs : brut, net, cotisations salariales sous le libellé de la caisse du pays, impôt sous son libellé, coût employeur, taux de prélèvement ;
  - le bulletin ligne par ligne avec ses explications ;
  - le détail de l'ancienneté et des heures supplémentaires ;
  - les avertissements ;
  - la comparaison « +1 enfant ».
- Les textes passent par i18n, en FR et EN, dans le namespace `payroll`.

## Tests

- **Golden ancienneté.** Pour chaque pack avec règle : 0, 1, 2, 3, 4, 5, 10, 24, 25 et 30 ans, avec les taux attendus du tableau ci-dessus. S'y ajoutent :
  - une date d'embauche au dernier jour du mois ;
  - une date d'embauche un 29 février ;
  - une embauche postérieure au mois de paie, qui renvoie 400.
- **Golden simulateur CIV.** Brut de 450 000, célibataire, sans enfant : l'ITS vaut 70 500, comme le moteur. Avec une ancienneté de 10 ans et un minimum de catégorie de 150 000, la prime vaut 15 000 et figure sur la ligne 1100.
- **Golden libellés d'heures supplémentaires.** Les libellés CIV sont inchangés, et ceux du Togo et du Sénégal sont dérivés de leur pack. Les fixtures golden existantes du moteur restent toutes vertes.
- **Route `countries`.** Elle renvoie exactement les 8 pays. Aucune donnée n'est inventée : pour un pack sans `primeTransportExoneree`, `transportZones` vaut null.
- **Route `simulate`.** Elle renvoie 400 pour un taux AT hors bornes, une zone inconnue, un minimum de catégorie inférieur au SMIG ou un pays hors UEMOA. Elle renvoie 403 pour les rôles manager, employee et readonly.
- **Web.** Changer de pays met à jour les libellés de la caisse et de l'impôt, le SMIG et la liste des zones. Le formulaire envoie le bon corps de requête.
