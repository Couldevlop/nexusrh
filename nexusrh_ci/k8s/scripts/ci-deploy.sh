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

# -- Helm --------------------------------------------------------------------
helm dependency update "$CHART"
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
for i in 1 2 3; do
  kubectl exec -n "$NS" "$API_POD" -- node dist/db/seed.js && break
  echo "Tentative $i echouee, nouvelle tentative dans 10s..."
  sleep 10
done

echo "== Deploiement termine : $(kubectl get pods -n "$NS" --no-headers | grep -c Running) pods Running"
