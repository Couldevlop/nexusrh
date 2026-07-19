# Runbook — Rotation des secrets démo exposés (prod) — A09-1

> **À exécuter par l'équipe** (touche la prod ; Claude n'exécute rien ici).
> **Contexte :** les mots de passe démo et le secret TOTP `mfa@sotra.ci` ont fuité (logs CI + repo). Le correctif code (`d86c7ea`, `113f357`) empêche les *futures* fuites ; ce runbook **invalide ce qui a déjà fuité**.
> **Cible :** cluster prod, namespace `nexusrh-ci` (API :4001).

---

## 1. Rotation des mots de passe (script existant, paramétré)

Le script `apps/api/src/db/reset-admin-passwords.ts` (bcrypt 12, idempotent) rejoue les hashes des comptes démo. Il lit les mots de passe depuis des variables d'env `SEED_*`. **Il suffit de le lancer avec des valeurs NEUVES** (jamais les défauts `Admin1234!`…).

### 1.1 Générer des mots de passe forts (poste local, hors repo)
```bash
for k in SUPERADMIN DEMO OPENLAB WOYAA; do
  echo "SEED_${k}_PASSWORD=$(openssl rand -base64 18)"
done
# → notez ces valeurs dans le coffre secrets de l'équipe (PAS dans le repo)
```

### 1.2 Exécuter la rotation en prod
Depuis un pod API du namespace `nexusrh-ci` (ou via `kubectl exec`), avec les nouvelles valeurs injectées **en variables d'env de la commande** (pas en clair dans un fichier versionné) :
```bash
kubectl -n nexusrh-ci exec deploy/nexusrh-api -- \
  env SEED_SUPERADMIN_PASSWORD='<neuf>' \
      SEED_DEMO_PASSWORD='<neuf>' \
      SEED_OPENLAB_PASSWORD='<neuf>' \
      SEED_WOYAA_PASSWORD='<neuf>' \
  node dist/db/reset-admin-passwords.js
```
> Le script cible : `superadmin@nexusrh-ci.com` (platform) + tous les comptes SOTRA / Cabinet Expertise / OpenLab / WOYAA / cabinet Talents. Il est **idempotent** (relançable).

---

## 2. Rotation du secret TOTP `mfa@sotra.ci`

Le secret `JBSWY3DPEHPK3PXP` est public → il faut le rendre inutile. Le plus sûr : **désactiver la MFA de ce compte et effacer le secret**, ce qui force un **ré-enrôlement** (nouveau secret aléatoire) à la prochaine activation.

```bash
kubectl -n nexusrh-ci exec deploy/nexusrh-api -- \
  psql "$DATABASE_URL" -c \
  "UPDATE tenant_sotra.users
     SET mfa_enabled = false, mfa_secret = NULL, mfa_backup_codes = NULL
   WHERE email = 'mfa@sotra.ci';"
```
> Puis, si ce compte doit rester MFA en démo : se reconnecter avec le nouveau mot de passe (étape 1) et **ré-activer la MFA** via `/auth/mfa/setup` → nouveau secret généré et **désormais chiffré au repos** (correctif A02-2, commit `60d3b73`).
> ⚠️ Vérifiez le nom exact des colonnes MFA (`mfa_backup_codes` peut différer) avant d'exécuter.

---

## 3. CI / dépôt

- **Seed** : ne printe plus les identifiants en prod (`d86c7ea`, `NODE_ENV!=='production'`) ; les valeurs passent par `SEED_*` (`113f357`). ✅
- **Logs GitHub Actions historiques** contenant l'ancien dump : ne peuvent pas être « dé-publiés » facilement → **la rotation ci-dessus est ce qui les rend inoffensifs**. (Option : supprimer les anciens runs concernés dans l'onglet Actions.)
- Si un credential doit un jour transiter par la CI : secret GitHub + `::add-mask::`.
- **Mot de passe prod `OpenLab2026#Nexus`** repéré (et retiré) dans l'arbre du README : confirmé **jamais committé dans l'historique git**, mais **à roter côté prod** par précaution (il a existé en clair sur disque).

---

## 4. Vérification post-rotation

1. Login avec un ancien mot de passe démo (`Admin1234!`) → **doit échouer**.
2. Login avec le nouveau mot de passe → OK.
3. `mfa@sotra.ci` : la MFA est désactivée (ou ré-enrôlée avec un secret neuf) ; l'ancien code TOTP `JBSWY3DPEHPK3PXP` → **refusé**.
4. Consigner dans le coffre secrets : nouvelles valeurs + date de rotation.

---

_Rotation opérationnelle — aucune modification de code. À archiver une fois exécutée (date + opérateur)._
