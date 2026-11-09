# Vérifier un export de piste d'audit NexusRH

> Document destiné à un **auditeur ou contrôleur externe** qui reçoit un export
> de piste d'audit et doit établir que ce qu'il lit est bien ce que
> l'application a produit, sans avoir accès à la base de données.
>
> Tout ce qui suit s'exécute sur le fichier reçu. Aucun accès à NexusRH, à son
> hébergeur ou à sa base n'est nécessaire.

---

## Ce que vous recevez

L'export se demande depuis **Sécurité → Piste d'audit → Exporter**. Il produit
un fichier CSV et un manifeste. Selon la forme choisie :

| Forme | Contenu |
|---|---|
| Téléchargement CSV | le fichier, et le manifeste dans les **en-têtes HTTP** de la réponse |
| Appel API JSON | `{ csv, manifest }` dans le corps de la réponse |

Le manifeste porte :

| Champ (JSON) | En-tête HTTP | Signification |
|---|---|---|
| `sha256` | `X-Audit-Sha256` | empreinte SHA-256 du fichier livré |
| `seal` | `X-Audit-Seal` | sceau HMAC-SHA256 du fichier (`none` si non scellé) |
| `sealed` | — | `false` quand aucune clé de scellement n'est configurée |
| `entries` | `X-Audit-Entries` | nombre d'entrées exportées |
| `chain.intact` | `X-Audit-Chain-Intact` | verdict du contrôle de chaînage interne |
| `firstHash` / `lastHash` | — | empreintes de la première et de la dernière entrée |

Les colonnes du CSV comprennent `prev_hash` et `entry_hash` : **les empreintes
voyagent avec les données**. C'est ce qui rend le contrôle reproductible par le
destinataire, et ce qui distingue un export probant d'une simple extraction.

---

## Trois contrôles, trois portées

Ils ne démontrent pas la même chose. À lire dans cet ordre.

### 1. Le fichier reçu est celui qui a été produit — SHA-256

Aucun secret requis. À faire d'abord : les deux autres contrôles n'ont de sens
que sur un fichier intact.

```bash
# Linux / macOS
sha256sum audit-tenant_sotra-2026-11-09.csv
```

```powershell
# Windows PowerShell
Get-FileHash .\audit-tenant_sotra-2026-11-09.csv -Algorithm SHA256
```

La valeur obtenue doit être **identique** à `X-Audit-Sha256`.

> **Le fichier se hache tel quel, sans la moindre retouche.** Le téléchargement
> CSV commence par un BOM UTF-8 (trois octets `EF BB BF`), nécessaire pour
> qu'Excel n'abîme pas les accents. Ce BOM fait partie du fichier et donc de
> l'empreinte. Ouvrir le fichier dans un tableur puis l'enregistrer le réécrit
> — fins de ligne, séparateur, encodage — et change l'empreinte. **Travaillez
> toujours sur une copie intacte du fichier d'origine** et réservez le tableur
> à la lecture.

Un écart ici signifie : fichier modifié, tronqué, ré-enregistré, ou transmis par
un canal qui l'a altéré. Il ne signifie pas, à lui seul, une falsification
intentionnelle.

### 2. Le chaînage interne n'a pas été rompu — SHA-256 par entrée

Aucun secret requis. C'est le contrôle le plus fort, et le seul qui porte sur le
**contenu** de la piste.

Chaque entrée porte l'empreinte de la précédente (`prev_hash`) et sa propre
empreinte (`entry_hash`), calculée par un déclencheur PostgreSQL au moment de
l'écriture. Trois propriétés en découlent :

- modifier une entrée change son `entry_hash` ;
- supprimer une entrée brise le lien `prev_hash` de la suivante ;
- réécrire un maillon oblige à réécrire **tous les suivants**, ce qui ne peut
  pas se faire par la modification d'une seule ligne.

Le champ `chain.intact` du manifeste porte le verdict calculé par l'application.
Pour le refaire vous-même sur le fichier, sans nous croire sur parole : chaque
ligne doit avoir pour `prev_hash` l'`entry_hash` de la ligne précédente.

```bash
# Contrôle du chaînage sur le fichier reçu, par les NOMS de colonnes.
# Un vrai lecteur CSV est indispensable : le champ `changes` est cité et
# contient souvent le point-virgule qui sert de séparateur — le découper
# naïvement décalerait les colonnes et inventerait des ruptures.
python3 - audit-tenant_sotra-2026-11-09.csv <<'EOF'
import csv, sys
# utf-8-sig : retire le BOM de l'intitulé de la première colonne.
with open(sys.argv[1], encoding='utf-8-sig', newline='') as f:
    lignes = list(csv.DictReader(f, delimiter=';'))
ko, precedent = 0, None
for i, l in enumerate(lignes):
    if precedent is not None and l['prev_hash'] != precedent:
        print(f"RUPTURE entree seq={l['seq']} : prev_hash={l['prev_hash']}, attendu {precedent}")
        ko += 1
    precedent = l['entry_hash']
print(f"{ko} rupture(s)" if ko else f"chainage intact sur {len(lignes)} entrees")
EOF
```

> Le `prev_hash` de la **première** entrée exportée est vide ou renvoie à une
> entrée antérieure à la période demandée : c'est normal sur un export partiel,
> et ce n'est pas une rupture.

### 3. C'est bien la plateforme qui a émis ce fichier — sceau HMAC

Nécessite la **clé de scellement**, que l'exploitant vous remet.

```bash
# Linux / macOS — la clé passe par l'environnement, jamais par la ligne de
# commande (elle resterait dans l'historique du shell et dans la liste des
# processus).
read -rs -p 'Clé de scellement : ' AUDIT_KEY; echo
openssl dgst -sha256 -mac HMAC -macopt "hexkey:$(printf %s "$AUDIT_KEY" | od -An -tx1 | tr -d ' \n')" \
  audit-tenant_sotra-2026-11-09.csv
unset AUDIT_KEY
```

```powershell
# Windows PowerShell
$cle   = Read-Host 'Clé de scellement' -AsSecureString
$clair = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
           [Runtime.InteropServices.Marshal]::SecureStringToBSTR($cle))
$hmac  = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($clair))
$octets = [IO.File]::ReadAllBytes((Resolve-Path .\audit-tenant_sotra-2026-11-09.csv))
-join ($hmac.ComputeHash($octets) | ForEach-Object { $_.ToString('x2') })
$clair = $null; $hmac.Dispose()
```

La valeur obtenue doit être identique à `X-Audit-Seal`.

> **Ce que le sceau démontre, et ce qu'il ne démontre pas.** Le scellement est
> un HMAC, donc **symétrique** : la même clé sert à sceller et à vérifier.
> Quiconque détient la clé peut produire un sceau indistinguable de celui de la
> plateforme. Le sceau n'établit donc la provenance que **vis-à-vis des parties
> qui ne détiennent pas la clé**. Plus la clé circule, moins il prouve.
>
> Les contrôles 1 et 2 n'ont pas cette limite : ils ne demandent aucun secret et
> restent vérifiables par n'importe qui, indéfiniment. Ce sont eux qui portent
> la démonstration ; le sceau ajoute l'attribution à l'émetteur.

#### `X-Audit-Seal: none`

Aucune clé de scellement n'est configurée sur l'installation. L'export reste
**exact et vérifiable** par les contrôles 1 et 2 — ce n'est pas un défaut
d'intégrité — mais sa provenance n'est pas attestée. L'écran d'export l'annonce
explicitement (« export NON SCELLÉ ») plutôt que de laisser croire au contraire.

Pour l'exploitant : la clé s'installe dans le secret du cluster sous
`audit-signing-key` et arrive à l'application par la variable
`AUDIT_SIGNING_KEY`. Elle n'est **jamais** écrite dans le dépôt.

---

## Mémo

| Vous voulez établir que… | Contrôle | Secret requis |
|---|---|---|
| le fichier n'a pas bougé depuis sa production | SHA-256 du fichier | non |
| aucune entrée n'a été modifiée ni supprimée | chaînage `prev_hash` / `entry_hash` | non |
| c'est bien la plateforme qui l'a émis | sceau HMAC | oui (clé) |

Un export dont les contrôles 1 et 2 passent est opposable sur son contenu, même
sans sceau.

---

## Pour l'exploitant : vérifier que la clé est bien installée

```bash
# Présence et longueur de la clé — la valeur n'est jamais affichée.
# 64 attendus : 32 octets en hexadécimal.
kubectl get secret nexusrh-app-secrets -n nexusrh-ci \
  -o jsonpath='{.data.audit-signing-key}' | base64 -d | wc -c
```

La preuve de bout en bout reste l'export lui-même : si `X-Audit-Seal` porte une
valeur au lieu de `none`, la clé est lue par l'application.
