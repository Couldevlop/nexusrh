# audit/ — Audit de sécurité NexusRH CI

Livrables de l'audit d'intrusion et de la remédiation des 29-30 août 2026.

| Fichier | Contenu |
|---|---|
| `RAPPORT-AUDIT-SECURITE.html` | Rapport détaillé : méthode, les 7 constats avec preuves et correctifs, ce qui a tenu sous l'attaque, l'architecture, ce qui n'a pas été corrigé et pourquoi. Ouvrir dans un navigateur (imprimable en PDF). |
| `2026-08-30-registre-vulnerabilites.xlsx` | Registre exploitable — 5 feuilles : Synthèse, Vulnérabilités, Dépendances, Architecture, Tests ajoutés. |
| `generate-registre.mjs` | Source de vérité du classeur. `node audit/generate-registre.mjs` le regénère : une mise à jour du registre se relit ainsi en diff. |

## Résultat en une ligne

118 vulnérabilités de dépendances → 2 (0 critique, 0 élevée) ; 5 constats applicatifs
corrigés, 2 qualifiés non applicables preuves à l'appui ; 4 835 tests verts.

## Tests permanents issus de l'audit

Les passes d'attaque ont été converties en tests, elles s'exécutent donc à chaque CI :

- `apps/api/src/security-authz-sweep.golden.test.ts` — les 450 routes sans jeton, avec un JWT forgé, avec un jeton `employee`
- `apps/api/src/security-hardening-2026-08.golden.test.ts` — rejoue S-02, S-06, S-07
- `apps/api/src/architecture-invariants.golden.test.ts` — interdit la recopie des primitives partagées, les services orphelins, `new Function()`/`eval()`
- `apps/api/src/modules/recruitment/cv-upload-signature.golden.test.ts` — signature des fichiers déposés
- `apps/api/src/services/antivirus.service.test.ts` — antivirus des dépôts (faux clamd en mémoire)

## À décider au déploiement

- `TRUST_PROXY` (défaut `loopback, uniquelocal`) — correct derrière l'ingress ; compléter si un CDN est ajouté devant.
- `CLAMAV_HOST` (vide par défaut) — l'analyse antivirale est **désactivée** tant qu'il n'est pas renseigné. Une fois activée, l'échec est **fermé** : si clamd est indisponible, les dépôts sont refusés.
