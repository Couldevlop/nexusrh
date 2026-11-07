/**
 * Page « deux modes de déploiement » (FR + EN).
 *
 * Intention unique : choisir entre SaaS et on-premise. La vitrine résume ces
 * deux modes (section #deploiement) et renvoie ici pour le détail ; aucune
 * autre page de contenu ne traite ce sujet (pas de cannibalisation).
 *
 * Règle éditoriale : rien qui ne soit vérifiable — aucun hébergeur, aucune
 * localisation imposée, aucun chiffre de disponibilité, aucun prix.
 */
import type { SeoPageContent } from './types'

const UPDATED = '2026-11-04'

export const DEPLOY_FR: SeoPageContent = {
  path: '/sirh-saas-ou-on-premise',
  lang: 'fr',
  kind: 'landing',
  title: 'SIRH et paie en SaaS ou on-premise : comparatif | NexusRH',
  description:
    'NexusRH en SaaS, hébergé par OpenLab Consulting, ou on-premise sur vos serveurs ou le datacenter de ' +
    'votre choix : hébergement, données, mises à jour.',
  h1: 'SIRH et paie : SaaS ou on-premise, deux modes de déploiement',
  lead:
    "NexusRH s'utilise de deux façons, avec les mêmes fonctionnalités : en SaaS, hébergé et maintenu par " +
    "OpenLab Consulting, ou en on-premise, installé sur vos serveurs ou dans le datacenter de votre choix.",
  crumb: 'SaaS ou on-premise',
  alternate: '/en/hris-saas-or-on-premise',
  updated: UPDATED,
  sections: [
    {
      h2: 'Le mode SaaS',
      id: 'saas',
      blocks: [
        { type: 'ul', items: [
          'Hébergé et maintenu par OpenLab Consulting.',
          'Mises à jour continues, sans intervention de votre part.',
          'Mise en route rapide : aucune infrastructure à préparer.',
          'Accès par navigateur web, sans logiciel à installer.',
          "Chaque entreprise dispose de son propre schéma de base de données : les données de deux clients ne partagent jamais les mêmes tables.",
        ] },
      ],
    },
    {
      h2: 'Le mode on-premise',
      id: 'on-premise',
      blocks: [
        { type: 'ul', items: [
          'Installé sur vos serveurs ou dans le datacenter de votre choix.',
          'Vos données restent dans votre infrastructure, dans le pays de votre choix.',
          'Adapté aux banques, au secteur public et aux organisations soumises à des exigences de souveraineté.',
          'Déploiement conteneurisé.',
          'Mises à jour livrées par OpenLab Consulting.',
        ] },
      ],
    },
    {
      h2: 'Comparatif',
      blocks: [
        { type: 'table', caption: 'SaaS et on-premise, critère par critère',
          head: ['Critère', 'SaaS', 'On-premise'],
          rows: [
            ['Hébergement', 'Par OpenLab Consulting', 'Sur vos serveurs ou dans le datacenter de votre choix'],
            ['Données', 'Isolées dans un schéma de base dédié à votre entreprise', 'Restent dans votre infrastructure'],
            ['Mises à jour', 'Continues', 'Livrées par OpenLab Consulting'],
            ['Mise en route', 'Rapide, sans infrastructure', 'Déploiement conteneurisé sur votre infrastructure'],
            ['Accès', 'Navigateur web', 'Navigateur web, sur votre réseau'],
            ['Pour qui', 'PME, ETI, groupes, cabinets', 'Banques, secteur public, organisations soumises à des exigences de souveraineté'],
          ] },
      ],
    },
    {
      h2: 'Ce qui ne change pas',
      blocks: [
        { type: 'ul', items: [
          "Le moteur de paie, avec les règles du pays de chaque société ; en Côte d'Ivoire : CNPS à double plafond, ITS 2024 avec RICF, déclarations CNPS et DISA.",
          "Double authentification (TOTP et codes de secours), contrôle d'accès par rôles, journal d'audit.",
          'Chiffrement AES-256 des secrets et données sensibles au repos.',
          'SSO OIDC, SAML ou LDAP et export SIEM avec le module sécurité.',
          "Paie : Côte d'Ivoire et UEMOA, extensible aux autres pays de la CEDEAO et de la CEMAC.",
        ] },
        { type: 'links', items: [
          { to: '/logiciel-paie-cote-divoire', label: 'Le logiciel de paie en détail' },
          { to: '/paiement-salaires-mobile-money', label: 'Payer les salaires par Mobile Money' },
        ] },
      ],
    },
  ],
  faq: [
    { q: 'Les fonctionnalités sont-elles les mêmes en SaaS et en on-premise ?',
      a: "Oui. C'est le même logiciel ; seuls changent le lieu d'installation et l'exploitant." },
    { q: 'Qui installe et met à jour la version on-premise ?',
      a: "OpenLab Consulting livre le logiciel en déploiement conteneurisé, sur vos serveurs ou dans le datacenter de votre choix, puis vous livre les mises à jour." },
    { q: 'Comment choisir entre les deux ?',
      a: "Le SaaS convient quand vous voulez démarrer vite sans gérer d'infrastructure. L'on-premise convient quand vos données ne doivent pas quitter votre infrastructure, comme c'est souvent le cas des banques et du secteur public." },
  ],
  related: ['/logiciel-paie-cote-divoire', '/paiement-salaires-mobile-money', '/sirh-afrique-ouest'],
}

export const DEPLOY_EN: SeoPageContent = {
  path: '/en/hris-saas-or-on-premise',
  lang: 'en',
  kind: 'landing',
  title: 'HRIS and payroll as SaaS or on-premise: compared | NexusRH',
  description:
    'NexusRH as SaaS, hosted by OpenLab Consulting, or on-premise on your own servers or in the datacenter ' +
    'of your choice: hosting, data and updates.',
  h1: 'HRIS and payroll: SaaS or on-premise, two deployment modes',
  lead:
    'NexusRH can be used in two ways, with the same features: as SaaS, hosted and maintained by OpenLab ' +
    'Consulting, or on-premise, installed on your own servers or in the datacenter of your choice.',
  crumb: 'SaaS or on-premise',
  alternate: '/sirh-saas-ou-on-premise',
  updated: UPDATED,
  sections: [
    {
      h2: 'SaaS',
      id: 'saas',
      blocks: [
        { type: 'ul', items: [
          'Hosted and maintained by OpenLab Consulting.',
          'Continuous updates, with nothing to do on your side.',
          'Fast start: no infrastructure to prepare.',
          'Web browser access, no software to install.',
          'Each company has its own database schema: two clients’ data never share the same tables.',
        ] },
      ],
    },
    {
      h2: 'On-premise',
      id: 'on-premise',
      blocks: [
        { type: 'ul', items: [
          'Installed on your own servers or in the datacenter of your choice.',
          'Your data stays within your infrastructure, in the country of your choice.',
          'Suited to banks, the public sector and organisations with sovereignty requirements.',
          'Containerised deployment.',
          'Updates delivered by OpenLab Consulting.',
        ] },
      ],
    },
    {
      h2: 'Comparison',
      blocks: [
        { type: 'table', caption: 'SaaS and on-premise, criterion by criterion',
          head: ['Criterion', 'SaaS', 'On-premise'],
          rows: [
            ['Hosting', 'By OpenLab Consulting', 'On your own servers or in the datacenter of your choice'],
            ['Data', 'Isolated in a database schema dedicated to your company', 'Stays within your infrastructure'],
            ['Updates', 'Continuous', 'Delivered by OpenLab Consulting'],
            ['Getting started', 'Fast, no infrastructure', 'Containerised deployment on your infrastructure'],
            ['Access', 'Web browser', 'Web browser, on your network'],
            ['Best for', 'SMEs, mid-caps, groups, firms', 'Banks, public sector, organisations with sovereignty requirements'],
          ] },
      ],
    },
    {
      h2: 'What stays the same',
      blocks: [
        { type: 'ul', items: [
          "The payroll engine, with the rules of each company's country; in Côte d'Ivoire: CNPS with its two ceilings, ITS 2024 with RICF, CNPS and DISA filings.",
          'Two-factor authentication (TOTP and backup codes), role-based access control, audit log.',
          'AES-256 encryption of secrets and sensitive data at rest.',
          'SSO with OIDC, SAML or LDAP and SIEM export with the security module.',
          "Payroll: Côte d'Ivoire and WAEMU, extendable to other ECOWAS and CEMAC countries.",
        ] },
        { type: 'links', items: [
          { to: '/en/hris-payroll-west-africa', label: 'HRIS and payroll for West Africa' },
        ] },
      ],
    },
  ],
  faq: [
    { q: 'Are the features the same in SaaS and on-premise?',
      a: 'Yes. It is the same software; only where it is installed and who operates it change.' },
    { q: 'Who installs and updates the on-premise version?',
      a: 'OpenLab Consulting delivers the software as a containerised deployment, on your own servers or in the datacenter of your choice, then delivers the updates.' },
    { q: 'How do we choose between the two?',
      a: 'SaaS suits you if you want to start quickly without running infrastructure. On-premise suits you if your data must not leave your infrastructure, as is often the case for banks and the public sector.' },
  ],
  related: ['/en/hris-payroll-west-africa'],
}
