# Formats de fichier bancaire paramétrables par tenant

Date : 2026-08-10 · Module : `bank-transfer` · Statut : validé

## Problème

`buildXlsx()` produit un `.xlsx` au gabarit figé (7 colonnes, en-tête orange, ligne TOTAL),
identique pour toutes les banques. Or chaque banque ivoirienne impose son propre format :
tableur à colonnes et intitulés différents, ou fichier texte à positions fixes.

## Principes

1. Le fichier exemple fourni par la banque sert à **deviner** la structure, jamais à générer.
   Ce qui génère est un **profil de fichier** : des données JSON en base, propriété du tenant.
2. **Le super_admin n'intervient jamais.** Aucun écran plateforme, aucune table `platform.*`.
   Des modèles de départ (Excel actuel, CSV délimité, TXT format fixe) sont livrés dans le code
   et clonables en un clic.
3. **Zéro régression** : une banque sans profil actif utilise le générateur Excel actuel, à l'identique.
4. Le format d'une banque est une **donnée** variable par tenant, pas une migration DDL.
   La migration crée la table une fois ; chaque changement de format est une ligne de plus.

## Modèle de données (schéma du tenant)

```
bank_file_templates
  id uuid PK · bank_name varchar(100) · version int · status draft|active|archived
  label · spec jsonb · output_kind xlsx|csv|fixed
  sample_filename · sample_structure jsonb    -- en-têtes/positions détectés SEULEMENT
  created_by · created_at · activated_at · archived_at
  UNIQUE(bank_name, version) + index unique partiel : un seul 'active' par banque
```

`bank_directory` étendue : `ordering_account` (RIB donneur d'ordre, chiffré),
`ordering_label`, `value_date_rule`.

**Le fichier exemple n'est jamais stocké.** Il contient souvent de vrais IBAN d'exemple ;
le conserver créerait une donnée personnelle orpheline. On extrait les en-têtes ou les
positions, on jette les octets.

## Cycle de vie

`brouillon` → aperçu sur une vraie paie → `Activer` → l'ancienne version passe en `archivé`
(jamais supprimée). Éditer un profil actif crée la version *n+1* en brouillon : on sait
toujours quel format a produit le fichier de janvier.

## Le profil (`spec` jsonb)

```jsonc
{
  "output": "fixed",              // xlsx | csv | fixed
  "encoding": "latin1",           // utf8 | latin1 (ISO-8859-1 fréquent sur les .txt bancaires)
  "delimiter": ";",               // csv uniquement
  "lineEnding": "crlf",
  "filename": "VIR_{banque}_{mois}.txt",
  "header": { "mode": "none|labels|custom", "lines": [[segment, ...], ...] },
  "columns": [ Column ],
  "footer": { "enabled": true, "lines": [[segment, ...], ...] }
}
```

```jsonc
Column /* et segment d'en-tête/pied */ = {
  "label": "COMPTE_BENEF",        // en-tête xlsx/csv, ignoré en format fixe
  "source": "employee.iban",      // liste FERMÉE
  "literal": null,                // si source = "literal"
  "transform": ["upper", "stripAccents", "digitsOnly", "alnum"],
  "pad": { "width": 24, "align": "left|right", "char": " " },
  "truncate": 24,
  "dateFormat": "DDMMYYYY|YYYYMMDD|DD/MM/YYYY",
  "amountScale": 1                // 1 = FCFA entier ; 100 si la banque veut des centimes
}
```

### Catalogue de sources (fermé)

| Groupe | Champs |
|---|---|
| Salarié | nom, prénom, nom complet, matricule, NNI, IBAN, banque, département, poste |
| Paie | net à payer, brut, mois |
| Donneur d'ordre | raison sociale, compte donneur d'ordre, libellé |
| Calculé | n° de ligne, nombre de lignes, montant total, date de valeur |
| Fixe | texte libre, jetons `{mois}`, `{annee}`, `{banque}` |

Catalogue **fermé par construction** : aucune expression n'est évaluée. Même choix que pour le
moteur de paie (piège #8) — on ne réintroduit pas un `safeEval` par la porte du paramétrage.

## Moteur

`bank-file.service.ts` — service pur, sans Fastify ni pool :

```
buildBankFile(spec, rows, ctx)       -> { buffer, filename, mime }   // csv | fixed (synchrone)
buildBankFileAsync(spec, rows, ctx)  -> Promise<{ ... }>             // tous formats (ExcelJS est asynchrone)
previewTable(spec, rows, ctx)        -> string[][]                   // aperçu écran, y compris xlsx
```

Trois rendus : `xlsx` (ExcelJS), `csv` (délimité + encodage + neutralisation anti-injection
réutilisée de `sage.service.ts`), `fixed` (positions, largeur garantie, troncature explicite).
En format fixe l'apostrophe anti-formule n'est PAS ajoutée : elle décalerait toutes les
positions du fichier. La neutralisation y remplace le caractère d'amorce (`=`, `@`) par une
espace — largeur conservée au caractère près, formule désamorcée. `+` et `-` sont laissés :
ils préfixent légitimement une valeur signée, et un fichier de virement corrompu est pire
qu'un tableur mal ouvert.

## Import assisté

- `.xlsx` / `.csv` : lecture de la ligne d'en-tête → une colonne proposée par en-tête,
  pré-mappée par rapprochement de libellé (`COMPTE|RIB|IBAN` → IBAN, `MONTANT|NET` → net à payer…).
  Le rapprochement se fait sur des **mots entiers**, et un intitulé commençant par un mot de
  zone technique (`ZONE`, `RESERVEE`, `FILLER`…) reste « à mapper » : sinon
  « ZONE_RESERVEE_BANQUE » serait proposé comme nom de banque.
- `.txt` : détection des largeurs par analyse des colonnes constantes sur plusieurs lignes.
  Les espaces séparant les champs sont conservés comme **segments de remplissage** — sans eux,
  toutes les positions du fichier régénéré se décalent. Limite assumée : si aucune ligne
  d'exemple ne remplit un champ, sa fin est indistinguable d'un blanc de séparation ; l'admin
  recale la frontière dans l'éditeur, la largeur totale de la ligne reste exacte.

Ce qui n'est pas reconnu reste explicitement « à mapper » et **bloque l'activation**.
Pas de devinette silencieuse : un mapping faux passe le contrôle et fait rejeter le fichier
par la banque.

Bornes : 1 Mo, extensions `.xlsx/.csv/.txt`, 200 lignes lues au maximum, octets jetés à la fin.

## API (préfixe `/bank-transfer`)

| Route | Rôle | Objet |
|---|---|---|
| `GET /templates` | admin | Profils par banque, avec statut |
| `POST /templates/import` | admin | Dépôt de l'exemple → structure + mapping proposé (ne crée rien) |
| `POST /templates` | admin | Crée la v1 en brouillon (ou clone un modèle de départ) |
| `PUT /templates/:id` | admin | Édite un brouillon ; sur un actif → crée la version n+1 en brouillon |
| `POST /templates/:id/preview` | admin | Rend sur une vraie paie : 10 lignes + fichier d'essai |
| `POST /templates/:id/activate` | admin | Active ; l'ancienne passe en archivé (transaction) |
| `GET /templates/:id` | admin | Détail d'une version (y compris archivée) |
| `GET /templates/:id/test-file` | admin | Fichier d'essai téléchargeable produit par le profil |
| `PUT /directory` | admin | Email de la banque + donneur d'ordre (compte chiffré) |

`GET /file` et `POST /send` : contrat inchangé, résolvent le profil actif, repli sur le
générateur Excel actuel s'il n'y en a pas.

## Écran

Onglet « Formats bancaires » dans la page paiements. Par banque : statut, version, date
d'activation. Éditeur = tableau de mapping + aperçu live, bandeau
`Brouillon — non utilisé pour les envois` tant que non activé. i18n fr/en.

## Sécurité

**Parseur (surface la plus dangereuse).** Bombe de décompression et XXE sont les classiques du
`.xlsx` (zip de XML). Bornes : 1 Mo en entrée, taille décompressée et nombre de lignes plafonnés
(200), aucune résolution d'entité externe, délai de parsing maximal, aucun contenu de cellule
renvoyé (en-têtes seuls). Aucun octet conservé.

**Générateur.** Catalogue fermé : pas d'`eval`, pas de moteur de gabarit Turing-complet, et
**aucune expression régulière fournie par l'admin** (sinon ReDoS). Le nom de fichier est un
gabarit à jetons, filtré sur `[A-Za-z0-9_.-]` après résolution : ni `..`, ni séparateur de
chemin, ni injection dans `Content-Disposition`. CSV : neutralisation anti-formule
(`= + - @`, tabulation, retour chariot). XLSX : valeurs écrites en texte ou nombre, jamais en formule.

**Données personnelles.** L'aperçu affiche des IBAN et NNI déchiffrés : `admin` seul, 10 lignes
maximum, `Cache-Control: no-store`, audité, jamais journalisé. `ordering_account` chiffré au
repos, masqué (`****1234`) en lecture, écriture seule.

**Isolation et accès.** Configuration `admin` seul (matrice RBAC : paramétrage tenant) ;
génération et envoi `admin` + `hr_manager`. Profils dans le schéma du tenant résolu depuis le
JWT — la requête est bornée au schéma, pas filtrée après coup. Zod `.strict()` partout, bornes
dures : 200 colonnes, 4 000 caractères de largeur cumulée, 50 versions par banque. Limitation
de débit sur dépôt, aperçu et envoi.

**Défaut existant corrigé au passage.** `bank-transfer.routes.ts` l.79 déclare
`addHook('preHandler')` au niveau du plugin, qui lit `request.user?.schemaName` — ce hook
s'exécute **avant** l'authentification, donc `ensureTenantSchema` n'est jamais appelé. Sur un
tenant existant la nouvelle table ne serait jamais créée et toutes les routes tomberaient en 500.
Passage en `preHandler` de route, après `authorize`.

## Tests

Service pur d'abord (TDD) : padding gauche/droite, troncature, montant entier FCFA, Latin-1
accentué, ligne totalisatrice, injection de formule neutralisée, gabarit de nom de fichier
hostile. Puis les routes : RBAC par rôle, isolation tenant, refus d'activer un mapping
incomplet, repli sur le générateur actuel sans profil, fichier hostile rejeté. Plus les
goldens `ui-api-contract` et i18n.
