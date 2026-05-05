# NexusRH CI — Guide d'installation K8s

---

## INFRASTRUCTURE EXISTANTE (k3s @ 62.238.11.20)

Le cluster k3s héberge déjà :
- **cert-manager** (namespace `cert-manager`)
- **ingress-nginx** (namespace `ingress-nginx`) — IP publique `62.238.11.20`
- **NexusRH CI** (namespace `nexusrh-ci`) — `nexusrh.openlabconsulting.com`

---

## DÉPLOYER UNE NOUVELLE APPLICATION (ex: sygescom)

### Pré-requis

1. **DNS** — Ajouter chez votre registrar (LWS) :
   ```
   sygescom.openlabconsulting.com  A  62.238.11.20
   ```
   Vérifier la propagation :
   ```bash
   nslookup sygescom.openlabconsulting.com
   ```

2. **Images Docker** — Pousser vers GHCR ou Docker Hub

---

### Étape 1 — Créer le namespace + secrets sur le VPS

```bash
ssh root@62.238.11.20

NAMESPACE=sygescom

kubectl create namespace $NAMESPACE

# Adapter les valeurs selon l'application
kubectl create secret generic sygescom-secrets \
  --from-literal=jwt-secret="CHANGE_ME_32chars_minimum" \
  --from-literal=db-password="CHANGE_ME" \
  -n $NAMESPACE
```

---

### Étape 2 — Créer un Ingress + ClusterIssuer Let's Encrypt

Créer le fichier `/tmp/sygescom-ingress.yaml` sur le VPS :

```bash
cat <<'EOF' > /tmp/sygescom-ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sygescom-ingress
  namespace: sygescom
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - sygescom.openlabconsulting.com
    secretName: sygescom-tls
  rules:
  - host: sygescom.openlabconsulting.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: sygescom-web-svc
            port:
              number: 3000
EOF
kubectl apply -f /tmp/sygescom-ingress.yaml
```

---

### Étape 3 — Déployer l'application via Helm ou manifests

**Option A — Chart Helm dédié** (recommandé) :
```bash
helm upgrade --install sygescom ./charts/sygescom \
  --namespace sygescom \
  -f values.prod.yaml
```

**Option B — Manifests directs** :
```bash
kubectl apply -f k8s/sygescom/ -n sygescom
```

---

### Étape 4 — Vérifier le certificat TLS

```bash
kubectl get certificate -n sygescom
# Attendre READY: True (1-2 min)
```

---

### Étape 5 — Seed / initialisation

```bash
kubectl exec -n sygescom deploy/sygescom-api -- node dist/db/seed.js
```

---

### Vérification finale

```bash
kubectl get pods,ingress,certificate -n sygescom
```
Puis ouvrir `https://sygescom.openlabconsulting.com` dans le navigateur.

---

## RÉINSTALLER NEXUSRH CI (cluster existant)

```bash
ssh root@62.238.11.20

# 1. Créer les secrets (si absents)
kubectl create secret generic nexusrh-app-secrets \
  --from-literal=jwt-secret="..." \
  --from-literal=anthropic-api-key="..." \
  --from-literal=smtp-user="..." \
  --from-literal=smtp-pass="..." \
  --from-literal=smtp-from="NexusRH <noreply@...>" \
  -n nexusrh-ci

kubectl create secret generic nexusrh-postgres-secret \
  --from-literal=postgres-password="..." -n nexusrh-ci

kubectl create secret generic nexusrh-redis-secret \
  --from-literal=redis-password="..." -n nexusrh-ci

kubectl create secret generic nexusrh-minio-secret \
  --from-literal=root-password="..." -n nexusrh-ci

kubectl create secret generic nexusrh-meilisearch-secret \
  --from-literal=master-key="..." -n nexusrh-ci

# Secret pull GHCR
kubectl create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io \
  --docker-username=Couldevlop \
  --docker-password=GITHUB_TOKEN \
  -n nexusrh-ci

# 2. Déployer via le pipeline GitHub Actions (push sur main)
# OU manuellement :
helm upgrade --install nexusrh-ci nexusrh_ci/k8s/charts/nexusrh \
  --namespace nexusrh-ci --create-namespace \
  -f nexusrh_ci/k8s/charts/nexusrh/values.yaml \
  -f nexusrh_ci/k8s/charts/nexusrh/values.prod.yaml

# 3. Seed
kubectl exec -n nexusrh-ci deploy/nexusrh-api -- node dist/db/seed.js
```

---

## COMMANDES UTILES

```bash
# État global
kubectl get pods -A

# Logs API
kubectl logs -n nexusrh-ci -l app.kubernetes.io/component=api -f

# Logs Worker
kubectl logs -n nexusrh-ci -l app.kubernetes.io/component=worker -f

# Redémarrer un déploiement
kubectl rollout restart deployment/nexusrh-api -n nexusrh-ci

# Certificats
kubectl get certificate -A

# Supprimer NetworkPolicies si blocage réseau
kubectl delete networkpolicy --all -n nexusrh-ci
```

---

## COMPTES DE CONNEXION — NexusRH CI

| Email | Mot de passe | Rôle |
|-------|-------------|------|
| `superadmin@nexusrh-ci.com` | `SuperAdmin1234!` | super_admin |
| `admin@sotra-ci.com` | `Admin1234!` | admin |
| `drh@sotra-ci.com` | `Admin1234!` | hr_manager |
| `manager@sotra-ci.com` | `Admin1234!` | manager |
| `employe@sotra-ci.com` | `Admin1234!` | employee |
| `admin@cabinet-expertise.ci` | `Admin1234!` | admin |

| Service | URL |
|---------|-----|
| Frontend | https://nexusrh.openlabconsulting.com |
| API | https://api.nexusrh.openlabconsulting.com |
| Swagger | https://api.nexusrh.openlabconsulting.com/docs |
