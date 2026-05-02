# NexusRH CI

**SIRH SaaS Multi-Tenant · Côte d'Ivoire**
*La RH Intelligente, au service de l'Afrique qui avance*

Développé par **OpenLab Consulting** · Cocody, Rivièra Faya Lauriers 8, Abidjan
Propulsé par **Claude AI** (Anthropic)

---

## Spécificités CI

| Conformité | Détail                                                                 |
|-----------|------------------------------------------------------------------------|
| **CNPS 2024** | Retraite 6,3% sal. / 7,7% pat. · PF 5,75% pat. · AT 2–5% selon secteur |
| **ITS / DGI** | Barème progressif · abattement 15% · crédits famille                   |
| **SMIG** | 75 000 FCFA / mois                                                     |
| **Congés** | 2,5 jours ouvrables / mois travaillé (Code du Travail CI)              |
| **DISA** | Génération automatique (loi 99-477)                                    |
| **e-CNPS** | Export compatible plateforme e-CNPS · avant le 15/mois                 |
| **Mobile Money** | Wave · MTN MoMo · Orange Money CI · COFINA                             |
| **OHADA** | Contrats conformes droit OHADA                                         |
| **FDFP** | Module formation · contribution 0,4% masse salariale                   |
| **Hébergement** | Option souverain CI (conformité ARTCI)                                 |

---

## Démarrage rapide

```bash
# 1. Infrastructure
docker-compose up -d postgres redis meilisearch minio

# 2. Variables d'environnement
cp .env.example .env
# Éditer .env : JWT_SECRET + ANTHROPIC_API_KEY

# 3. Dépendances + seed
pnpm install
pnpm --filter api run db:seed

# 4. Lancer
pnpm run dev
```

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3001 |
| API + Swagger | http://localhost:4001/docs |
| MinIO | http://localhost:9003 |

---

## Comptes de test

| Email | Mot de passe | Rôle |
|-------|-------------|------|
| `superadmin@nexusrh-ci.com` | `SuperAdmin1234!` | super_admin |
| `admin@sotra-ci.com` | `Admin1234!` | admin (SOTRA) |
| `drh@sotra-ci.com` | `Admin1234!` | hr_manager |
| `employe@sotra-ci.com` | `Admin1234!` | employee |
| `admin@cabinet-expertise.ci` | `Admin1234!` | admin (Cabinet) |

---

## Mode sans echec
 Mode maintenance — comportement attendu                                                                                                                                                                       
  Oui, le super_admin doit garder l'accès. Voici la logique correcte :                                                                                                                                          
  ┌────────────────────────────────┬──────────────────────┬─────────────────────────────────────────┐
  │            Requête             │ Mode maintenance OFF │           Mode maintenance ON           │
  ├────────────────────────────────┼──────────────────────┼─────────────────────────────────────────┤
  │ POST /auth/login               │ ✅                   │ ✅ (sinon plus personne ne peut entrer)│
  ├────────────────────────────────┼──────────────────────┼─────────────────────────────────────────┤
  │ GET /platform/* (super_admin)  │ ✅                   │ ✅                                     │
  ├────────────────────────────────┼──────────────────────┼─────────────────────────────────────────┤
  │ GET/POST /api/* (tous tenants) │ ✅                   │ ❌ 503                                 │
  ├────────────────────────────────┼────────────────────── ┼─────────────────────────────────────────┤
  │ Frontend tenants               │ ✅                   │ 🔴 Bannière "Maintenance"              │
  └────────────────────────────────┴──────────────────────-┴─────────────────────────────────────────┘

## Contact

**OpenLab Consulting**
📍 Cocody, Rivièra Faya Lauriers 8, Abidjan
📧 infos@openlabconsulting.com
📱 +225 07 09 32 05 94
🌐 www.openlabconsulting.com

---

*NexusRH CI — Conforme Code du Travail ivoirien & CNPS 2024*
