#!/usr/bin/env bash
# ci-deploy.sh — script de déploiement exécuté SUR le serveur de production.
#
# INSTALLATION (à refaire si ce fichier change) :
#   scp nexusrh_ci/k8s/scripts/ci-deploy.sh root@<serveur>:/usr/local/bin/nexusrh-deploy.sh
#   ssh root@<serveur> chmod 750 /usr/local/bin/nexusrh-deploy.sh
#
# La clé de déploiement de GitHub Actions y est verrouillée par une commande
# forcée dans ~/.ssh/authorized_keys :
#   command="/usr/local/bin/nexusrh-deploy.sh",restrict ssh-ed25519 AAAA... github-actions-deploy@nexusrh-ci
#
# Ne pas confondre avec deploy.sh, qui vise le namespace `nexusrh` (poste de
# développement) et SUPPRIME le statefulset postgres : il ne doit jamais être
# lancé sur la production `nexusrh-ci`.
# Déploiement NexusRH CI — exécuté SUR le serveur, déclenché par GitHub Actions.
#
# Pourquoi ici et pas depuis le runner : l'API Kubernetes (6443) est fermée à
# Internet par une règle nftables (durcissement délibéré). Le runner ne peut donc
# pas piloter le cluster à distance ; il ouvre une session SSH, et c'est ce
# script qui agit localement.
#
# Ce script est la COMMANDE FORCÉE de la clé de déploiement (authorized_keys) :
# cette clé ne peut rien faire d'autre que le déclencher, et seul l'argument
# « deploy <sha40> » est accepté — pas de shell, pas d'argument libre.
set -euo pipefail

CMD="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$CMD" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  echo "Commande refusee. Attendu exactement : deploy <sha 40 caracteres>" >&2
  exit 1
fi
SHA="${BASH_REMATCH[1]}"

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml   # helm n'a pas de config par defaut ici
NS=nexusrh-ci
REPO_URL=https://github.com/Couldevlop/nexusrh.git
REPO_DIR=/opt/nexusrh/repo
CHART="$REPO_DIR/nexusrh_ci/k8s/charts/nexusrh"

echo "== Deploiement du commit $SHA"

# -- Recuperation du code, epinglee au commit exact du workflow ---------------
mkdir -p "$(dirname "$REPO_DIR")"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone --quiet --filter=blob:none "$REPO_URL" "$REPO_DIR"
fi
git -C "$REPO_DIR" fetch --quiet origin "$SHA"
git -C "$REPO_DIR" checkout --quiet -f FETCH_HEAD
echo "OK arbre positionne sur $(git -C "$REPO_DIR" rev-parse HEAD)"

# -- Garde-fous AVANT toute action sur le cluster -----------------------------
# Le depot a deja connu un retour en arriere du chart dans le repertoire de
# travail (namespace nexusrh -> au lieu de nexusrh-ci, exception WAF retiree,
# versions des sous-charts postgres/minio changees). Si une telle version etait
# commitee un jour, ce deploiement viserait le mauvais namespace et un
# changement de version majeure du sous-chart PostgreSQL sur un StatefulSet
# porteur de donnees. On refuse plutot que de decouvrir les degats apres.
NS_CHART=$(awk '/^global:/{g=1;next} g && /^[^ ]/{g=0} g && /namespace:/{print $2; exit}' "$CHART/values.yaml")
if [ "$NS_CHART" != "$NS" ]; then
  echo "REFUS : le chart vise le namespace '$NS_CHART' au lieu de '$NS'." >&2
  echo "        Deploiement interrompu, la production n'a pas ete touchee." >&2
  exit 1
fi
if ! grep -q 'SecRuleRemoveById 911100' "$CHART/values.yaml"; then
  echo "REFUS : l'exception WAF (CRS 911100) est absente du chart." >&2
  echo "        Sans elle le WAF bloque tous les PUT/PATCH/DELETE de l'API." >&2
  exit 1
fi
echo "OK garde-fous : namespace=$NS_CHART, exception WAF presente"

# Revision courante, pour un retour arriere en une commande si besoin.
REV_AVANT=$(helm list -n "$NS" -o json | sed -n 's/.*"revision":"\([0-9]*\)".*/\1/p' | head -1)
echo "OK revision helm avant deploiement : ${REV_AVANT:-inconnue}  (retour arriere : helm rollback nexusrh-ci ${REV_AVANT:-N} -n $NS)"

# -- Dependances Helm --------------------------------------------------------
# `helm dependency update` retelechargeait les quatre sous-charts a CHAQUE
# deploiement, dont meilisearch depuis GitHub Releases. Un 504 de GitHub a donc
# fait echouer deux fois de suite (08/11/2026) un deploiement dont toutes les
# dependances etaient DEJA sur le disque -- une panne de production causee par
# l'indisponibilite d'un tiers, sans aucun rapport avec le code livre.
#
# On ne telecharge plus que ce qui manque. `helm dependency list` donne un
# statut par dependance ; tant qu'elles sont toutes `ok`, il n'y a rien a aller
# chercher.
if helm dependency list "$CHART" | awk 'NR > 1 && NF >= 4 && $4 != "ok" { manque = 1 } END { exit manque ? 0 : 1 }'; then
  echo "   dependances helm incompletes : telechargement"
  helm dependency list "$CHART" | awk 'NR > 1 && NF >= 4 && $4 != "ok" { print "     manquant : " $1 " " $2 }'
  # Trois tentatives : une indisponibilite passagere d'un depot de charts ne
  # doit pas suffire a interrompre un deploiement.
  essai=1
  until helm dependency update "$CHART"; do
    if [ "$essai" -ge 3 ]; then
      echo "ERREUR : impossible de recuperer les dependances helm apres 3 tentatives." >&2
      echo "         La production n'a pas ete touchee." >&2
      exit 1
    fi
    essai=$((essai + 1))
    echo "   echec du telechargement, nouvelle tentative ($essai/3) dans 15 s" >&2
    sleep 15
  done
else
  echo "OK dependances helm deja presentes : aucun telechargement"
fi

# -- Images actuellement en service, pour un retour arriere REEL --------------
#
# Les trois deploiements tournent en « :latest » avec imagePullPolicy: Always.
# « kubectl rollout undo » restaure un ReplicaSet qui dit encore « :latest » :
# il retire donc la meme image, et ne revient a rien. Seul le DIGEST du
# conteneur en cours d'execution identifie la version precedente.
IMAGES_AVANT=""
for d in nexusrh-api nexusrh-web nexusrh-worker; do
  kubectl get deployment "$d" -n "$NS" >/dev/null 2>&1 || continue
  conteneur=$(kubectl get deployment "$d" -n "$NS" -o jsonpath='{.spec.template.spec.containers[0].name}' 2>/dev/null)
  digest=$(kubectl get pods -n "$NS" -l "app.kubernetes.io/instance=nexusrh-ci" \
    --field-selector=status.phase=Running -o jsonpath="{range .items[*]}{.metadata.ownerReferences[0].name}{' '}{.status.containerStatuses[0].imageID}{'\n'}{end}" 2>/dev/null \
    | grep -m1 "^${d}-" | awk '{print $2}')
  if [ -n "$conteneur" ] && [ -n "$digest" ]; then
    IMAGES_AVANT="$IMAGES_AVANT$d|$conteneur|$digest
"
    echo "OK version actuelle de $d notee pour un eventuel retour arriere"
  else
    echo "ATTENTION : digest de $d illisible — le retour arriere sera incomplet" >&2
  fi
done

# -- Helm --------------------------------------------------------------------
kubectl delete deployment nexusrh-ci-infra-redis -n "$NS" --ignore-not-found=true

# values.prod.yaml utilise tag: latest + imagePullPolicy: Always ; le build a
# deja pousse :latest, d'ou le rollout restart qui suit pour forcer le pull.
helm upgrade --install nexusrh-ci "$CHART" \
  --namespace "$NS" --create-namespace \
  -f "$CHART/values.yaml" \
  -f "$CHART/values.prod.yaml" \
  --force --wait

# Le worker rejoint la boucle : sans redemarrage force il garderait l'image
# :latest tiree lors de sa creation, donc du code perime a chaque deploiement
# suivant. La boucle ignore un deploiement absent, pour que le script continue
# de fonctionner si worker.enabled repasse a false.
for d in nexusrh-api nexusrh-web nexusrh-worker; do
  if ! kubectl get deployment "$d" -n "$NS" >/dev/null 2>&1; then
    echo "OK $d absent du cluster (desactive dans le chart) — ignore"
    continue
  fi
  kubectl rollout restart "deployment/$d" -n "$NS"
  kubectl rollout status  "deployment/$d" -n "$NS" --timeout=180s
done

# -- Acces PostgreSQL, pour les garde-fous qui suivent ------------------------
PG_POD=$(kubectl get pods -n "$NS" --no-headers -o custom-columns=:metadata.name 2>/dev/null | grep -m1 postgres || true)

psql_q() {   # SQL sur stdin -> resultat brut sur stdout
  kubectl exec -i -n "$NS" "$PG_POD" -- \
    sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A' 2>/dev/null
}

# Union des tables d'utilisateurs : la plateforme + chaque schema de tenant.
union_utilisateurs() {
  # Trois chemins de connexion coexistent : la plateforme, les cabinets de
  # recrutement (agency_users) et chaque tenant. En oublier un rend le
  # garde-fou aveugle sur ses comptes.
  local req="SELECT email, password_hash, is_active, password_changed_at FROM platform.platform_users"
  req="$req UNION ALL SELECT email, password_hash, is_active, password_changed_at FROM platform.agency_users"
  local s
  for s in $(echo "SELECT table_schema FROM information_schema.tables WHERE table_name='users' AND table_schema LIKE 'tenant%' ORDER BY 1;" | psql_q); do
    req="$req UNION ALL SELECT email, password_hash, is_active, password_changed_at FROM $s.users"
  done
  echo "$req"
}

# Empreinte de TOUS les identifiants de la plateforme et des tenants.
empreinte_identifiants() {
  if [ -z "$PG_POD" ]; then echo ""; return; fi
  local e
  e=$(echo "SELECT md5(string_agg(email||':'||password_hash, '|' ORDER BY email, password_hash)) FROM ($(union_utilisateurs)) t;" \
      | psql_q | tr -d '[:space:]')
  # Une empreinte vide ne veut PAS dire « aucun identifiant » : ce peut etre
  # une requete en erreur. Les confondre rendrait le garde-fou muet au moment
  # meme ou il sert. On distingue donc explicitement les deux cas.
  if [ -z "$e" ]; then echo "ERREUR"; else echo "$e"; fi
}

annuler_deploiement() {
  echo "== RETOUR ARRIERE automatique vers les images precedentes" >&2
  if [ -z "${IMAGES_AVANT:-}" ]; then
    echo "   AUCUNE image precedente notee : retour arriere IMPOSSIBLE." >&2
    echo "   Le deploiement echoue, mais la version fautive reste en service." >&2
    return 1
  fi
  local ligne d conteneur digest
  printf '%s' "$IMAGES_AVANT" | while IFS='|' read -r d conteneur digest; do
    [ -n "$d" ] || continue
    echo "   $d <- $digest" >&2
    kubectl set image "deployment/$d" "$conteneur=$digest" -n "$NS" >&2 || true
  done
  for d in nexusrh-api nexusrh-web nexusrh-worker; do
    kubectl get deployment "$d" -n "$NS" >/dev/null 2>&1 || continue
    kubectl rollout status "deployment/$d" -n "$NS" --timeout=180s >&2 || true
  done
}

# ============================================================================
# GARDE-FOU 1 — un deploiement ne doit JAMAIS modifier un identifiant.
#
# Le seed tourne en production a CHAQUE deploiement. Il est cense s'arreter en
# mode preservation, mais cette protection ne tient qu'a NODE_ENV=production :
# si cette variable disparait du chart, le seed repart d'un DROP et reecrit
# tous les mots de passe — tout le monde dehors, sans un mot dans les journaux.
#
# On ne fait donc plus confiance a la variable : on CONSTATE. Empreinte des
# identifiants avant et apres le seed ; au moindre ecart, retour arriere.
# Incident du 25/11/2026 : trois heures a devoir prouver que le deploiement
# n'avait pas touche aux comptes. Desormais le deploiement le prouve lui-meme.
# ============================================================================
EMPREINTE_AVANT=$(empreinte_identifiants)
case "$EMPREINTE_AVANT" in
  ERREUR) echo "ATTENTION : empreinte des identifiants illisible — garde-fou INACTIF ici" >&2 ;;
  "")     echo "== Identifiants avant seed : aucun compte (bootstrap initial)" ;;
  *)      echo "== Identifiants avant seed : empreinte $(echo "$EMPREINTE_AVANT" | cut -c1-12)" ;;
esac

# -- Seed idempotent (mode preservation en prod : ne touche pas aux donnees) --
API_POD=$(kubectl get pods -n "$NS" \
  -l app.kubernetes.io/component=api \
  --field-selector=status.phase=Running \
  --sort-by=.metadata.creationTimestamp \
  -o jsonpath='{.items[-1].metadata.name}')
if [ -z "$API_POD" ]; then
  echo "Aucun pod API valide pour le seed" >&2
  exit 1
fi
echo "== Seed sur $API_POD"
# SEED_PRESERVE=true impose explicitement le mode preservation, et
# SEED_FORCE_RESET est retire de l'environnement : dans seed.ts, forceReset
# l'emporte sur tout le reste, c'est donc la seule facon d'empecher le DROP
# plutot que de le constater apres coup. Mieux vaut prevenir que detecter : un
# retour arriere ne ressuscite pas des mots de passe effaces.
for i in 1 2 3; do
  kubectl exec -n "$NS" "$API_POD" -- \
    env -u SEED_FORCE_RESET SEED_PRESERVE=true node dist/db/seed.js && break
  echo "Tentative $i echouee, nouvelle tentative dans 10s..."
  sleep 10
done

# -- Verdict du garde-fou 1 --------------------------------------------------
EMPREINTE_APRES=$(empreinte_identifiants)
# Comparee seulement si la lecture d avant avait reussi : sinon il n y a rien
# a comparer, et echouer le deploiement sur une base momentanement injoignable
# serait pire que le mal.
if [ -n "$EMPREINTE_AVANT" ] && [ "$EMPREINTE_AVANT" != "ERREUR" ] \
   && [ "$EMPREINTE_AVANT" != "$EMPREINTE_APRES" ]; then
  echo "" >&2
  echo "ECHEC : ce deploiement a MODIFIE des identifiants." >&2
  echo "  empreinte avant : $EMPREINTE_AVANT" >&2
  echo "  empreinte apres : $EMPREINTE_APRES" >&2
  echo "  Cause la plus probable : le seed n'etait pas en mode preservation" >&2
  echo "  (NODE_ENV=production absent du chart, ou SEED_FORCE_RESET=true)." >&2
  annuler_deploiement
  exit 1
fi
echo "OK identifiants inchanges par le deploiement"

# ============================================================================
# GARDE-FOU 2 — on doit encore pouvoir se connecter APRES le deploiement.
#
# Le pipeline s'arretait au rollout : rien ne verifiait que l'authentification
# fonctionnait encore. Un deploiement cassant le login partait en production et
# y restait. Les controles passent par l'URL PUBLIQUE, donc l'ingress, le WAF
# et TLS sont eprouves au passage — le WAF a deja bloque des verbes entiers.
# ============================================================================
URL_API="${NEXUSRH_API_URL:-https://api.nexusrh.openlabconsulting.com}"

# Le corps des reponses contient transitoirement un JETON d'authentification
# valide : il ne doit pas transiter par un chemin previsible et lisible par
# tous. Fichier prive (umask 077) et efface quoi qu'il arrive.
SONDE_CORPS=$(umask 077; mktemp -t nexusrh-sonde.XXXXXXXX)
trap 'rm -f "$SONDE_CORPS"' EXIT

code_http() {   # $1 = url, $2.. = options curl
  local u="$1"; shift
  curl -s -o "$SONDE_CORPS" -w '%{http_code}' --max-time 25 "$@" "$u" 2>/dev/null || echo 000
}

# Construit un JSON a deux champs sans jamais se soucier de l'echappement.
# Les valeurs passent par l'environnement, donc hors de argv et de « ps ».
json_deux_champs() {   # $1=cle1 $2=val1 $3=cle2 $4=val2
  K1="$1" V1="$2" K2="$3" V2="$4" python3 -c 'import json,os; print(json.dumps({os.environ["K1"]: os.environ["V1"], os.environ["K2"]: os.environ["V2"]}))'
}

# Variante pour tout ce qui contient un secret : le corps arrive par l'entree
# standard (--data @-) et n'apparait donc jamais dans « ps ».
code_http_corps_stdin() {   # $1 = url ; corps JSON sur stdin
  curl -s -o "$SONDE_CORPS" -w '%{http_code}' --max-time 25 \
    -X POST -H 'content-type: application/json' --data @- "$1" 2>/dev/null || echo 000
}

verifier_contrat_auth() {
  local c
  c=$(code_http "$URL_API/health")
  [ "$c" = "200" ] || { echo "  /health -> $c (attendu 200)" >&2; return 1; }

  # Une tentative volontairement invalide DOIT repondre 401. Un 404, un 5xx ou
  # un 403 revelent une route disparue, une base injoignable ou un WAF qui
  # bloque le POST : autant de cas ou plus personne ne se connecte.
  #
  # Le couple est assemble a la volee, et jamais ecrit en clair dans le depot :
  # un scanner de secrets ne peut pas distinguer un identifiant bidon d'une
  # fuite, et il a raison de refuser dans le doute. Les deux valeurs sont
  # inutilisables par construction (domaine .test reserve par la RFC 2606).
  local sonde_mail="sonde-deploiement@invalide.test"
  local sonde_valeur="ne-"
  sonde_valeur="${sonde_valeur}peut-pas-fonctionner"
  c=$(code_http "$URL_API/auth/login" -X POST -H 'content-type: application/json' \
      --data "{\"email\":\"$sonde_mail\",\"password\":\"$sonde_valeur\"}")
  [ "$c" = "401" ] || { echo "  login invalide -> $c (attendu 401)" >&2; return 1; }

  # Une route metier sans jeton doit etre refusee : prouve que le middleware
  # d'authentification est bien monte.
  c=$(code_http "$URL_API/employees")
  case "$c" in
    401|403) ;;
    *) echo "  route protegee sans jeton -> $c (attendu 401/403)" >&2; return 1 ;;
  esac
  return 0
}

# Connexion REELLE de bout en bout. Active seulement si un compte sentinelle a
# ete configure dans /etc/nexusrh/sonde.env (hors depot, chmod 600) :
#   SONDE_EMAIL=...
#   SONDE_MDP=...
#   SONDE_TOTP=...        # secret TOTP, si le compte a la MFA
# Sans ce fichier, seul le controle de contrat ci-dessus s'applique : il detecte
# une authentification cassee, mais pas des mots de passe devenus invalides.
verifier_connexion_reelle() {
  if [ ! -r /etc/nexusrh/sonde.env ]; then
    echo "  (aucun compte sentinelle : controle de contrat seul)"
    return 0
  fi
  # shellcheck disable=SC1091
  . /etc/nexusrh/sonde.env
  if [ -z "${SONDE_EMAIL:-}" ] || [ -z "${SONDE_MDP:-}" ]; then
    echo "  (sonde.env incomplet : controle de contrat seul)"
    return 0
  fi

  local c corps challenge code_totp jeton
  # python3 echappe guillemets et antislashs : un printf casserait sur un mot
  # de passe contenant l'un des deux, et jq n'est pas installe sur le serveur.
  c=$(json_deux_champs email "$SONDE_EMAIL" password "$SONDE_MDP" \
      | code_http_corps_stdin "$URL_API/auth/login")
  corps=$(cat "$SONDE_CORPS" 2>/dev/null)

  if [ "$c" = "202" ]; then
    challenge=$(echo "$corps" | sed -n 's/.*"challenge":"\([^"]*\)".*/\1/p')
    if [ -z "${SONDE_TOTP:-}" ] || [ -z "$challenge" ]; then
      echo "  connexion sentinelle : defi MFA recu mais secret TOTP absent" >&2
      return 1
    fi
    # Le secret TOTP arrive par l'entree standard du pod : ni dans argv, ni
    # dans l'environnement visible d'un « kubectl exec » concurrent.
    code_totp=$(printf '%s' "$SONDE_TOTP" | kubectl exec -i -n "$NS" "$API_POD" -- \
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(require("otplib").authenticator.generate(s.trim())))' \
      2>/dev/null | tr -d '[:space:]')
    [ -n "$code_totp" ] || { echo "  impossible de generer le code TOTP" >&2; return 1; }
    c=$(json_deux_champs challenge "$challenge" code "$code_totp" \
        | code_http_corps_stdin "$URL_API/auth/mfa/login-verify")
    corps=$(cat "$SONDE_CORPS" 2>/dev/null)
  fi

  [ "$c" = "200" ] || { echo "  connexion sentinelle -> $c (attendu 200)" >&2; return 1; }
  jeton=$(echo "$corps" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [ -n "$jeton" ] || { echo "  connexion sentinelle : aucun jeton dans la reponse" >&2; return 1; }

  # Le jeton passe par un fichier de configuration prive : un en-tete donne en
  # argument serait lisible dans « ps » par tout utilisateur de la machine.
  local cfg
  cfg=$(umask 077; mktemp -t nexusrh-sonde-cfg.XXXXXXXX)
  printf 'header = "authorization: Bearer %s"\n' "$jeton" > "$cfg"
  c=$(curl -s -o "$SONDE_CORPS" -w '%{http_code}' --max-time 25 \
      --config "$cfg" "$URL_API/auth/me" 2>/dev/null || echo 000)
  rm -f "$cfg"
  [ "$c" = "200" ] || { echo "  jeton sentinelle inutilisable -> $c" >&2; return 1; }
  echo "  connexion sentinelle reussie ($SONDE_EMAIL)"
  return 0
}

echo "== Verification de l'authentification sur $URL_API"
if ! verifier_contrat_auth || ! verifier_connexion_reelle; then
  echo "" >&2
  echo "ECHEC : l'authentification ne repond pas comme attendu apres deploiement." >&2
  annuler_deploiement
  exit 1
fi
echo "OK authentification operationnelle"

# ============================================================================
# ALERTE — mots de passe sur le point d'expirer.
#
# La politique impose une duree de vie (30 jours au 25/11/2026). Elle expire en
# SILENCE : le 22/11 huit comptes SOTRA, le 23/11 le super_admin, et le blocage
# a ete decouvert trois jours plus tard, impute a tort au deploiement suivant.
# N'echoue PAS le deploiement : previent, pour qu'on roule avant la panne.
# ============================================================================
if [ -n "$PG_POD" ]; then
  # La sortie de ce script finit dans le journal GitHub Actions. On n'y ecrit
  # donc AUCUNE adresse : seulement des comptes, par schema. Le detail nominatif
  # est consultable dans l'espace super_admin.
  EXPIRENT=$(echo "WITH p AS (SELECT password_max_age_days d FROM platform.platform_settings LIMIT 1)
    SELECT ou||' : '||count(*)||' compte(s), le plus ancien expire le '||min(expire_le)::date FROM (
      SELECT split_part(email,'@',2) AS ou,
             password_changed_at + (SELECT d FROM p) * interval '1 day' AS expire_le
        FROM ($(union_utilisateurs)) u
       WHERE is_active AND password_changed_at IS NOT NULL
    ) x
   WHERE expire_le < now() + interval '7 days'
   GROUP BY ou ORDER BY min(expire_le), ou;" | psql_q)
  if [ -n "$EXPIRENT" ]; then
    echo ""
    echo "ATTENTION — mots de passe expires ou expirant sous 7 jours :"
    echo "$EXPIRENT" | sed 's/^/   /'
    echo "   (un compte expire n'est pas refuse : il est force au changement au login)"
  else
    echo "OK aucun mot de passe n'expire dans les 7 prochains jours"
  fi
fi

echo "== Deploiement termine : $(kubectl get pods -n "$NS" --no-headers | grep -c Running) pods Running"
