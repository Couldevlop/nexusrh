import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config.js'

// Création PARESSEUSE du transporter : on ne lit `config.smtp` qu'au premier
// envoi réel, jamais à l'import du module. Évite tout effet de bord à
// l'import (Clean Architecture) — un module qui importe email.ts (ex.
// settings.routes) ne dépend plus de la présence de config.smtp au chargement,
// ce qui casserait notamment les tests qui mockent une config partielle.
let _transporter: Transporter | null = null
function getTransporter(): Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      requireTLS: config.smtp.host === 'smtp.gmail.com',
      tls: { rejectUnauthorized: false },
    })
  }
  return _transporter
}

// En-tête de marque : affiche le LOGO uploadé (URL absolue servie par
// /public/brand/:id) s'il est fourni, sinon les initiales colorées (fallback).
// L'URL doit être absolue et publiquement accessible pour s'afficher dans les
// clients mail (Gmail/Outlook bloquent les data: URLs).
function brandHeader(name: string, subtitle: string, primaryColor: string, logoUrl?: string | null): string {
  const badge = logoUrl
    ? `<img src="${logoUrl}" alt="${name}" width="48" height="48" style="width:48px;height:48px;border-radius:10px;object-fit:contain;background:#fff;display:block;" />`
    : `<div style="width:48px;height:48px;background:rgba(255,255,255,0.2);border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;color:#fff;">${name.slice(0, 2).toUpperCase()}</div>`
  return `
            <td style="background:${primaryColor};padding:32px 40px;text-align:center;">
              <div style="display:inline-flex;align-items:center;gap:12px;">
                ${badge}
                <div style="text-align:left;">
                  <p style="margin:0;font-size:20px;font-weight:700;color:#fff;">${name}</p>
                  <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.8);">${subtitle}</p>
                </div>
              </div>
            </td>`
}

export async function sendWelcomeTenantEmail(params: {
  to: string
  firstName: string
  lastName: string
  tenantName: string
  tenantCity: string
  primaryColor: string
  loginUrl: string
  tempPassword: string
  plan: string
  logoUrl?: string | null
  from?: string | null
  replyTo?: string | null
}): Promise<void> {
  const { to, firstName, lastName, tenantName, tenantCity, primaryColor, loginUrl, tempPassword, plan, logoUrl, from, replyTo } = params

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bienvenue sur NexusRH CI</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>${brandHeader(tenantName, `${tenantCity} · NexusRH CI`, primaryColor, logoUrl)}
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:600;">BIENVENUE</p>
              <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#111827;">
                Bonjour ${firstName} ${lastName} 👋
              </h1>
              <p style="margin:0 0 24px;font-size:16px;color:#374151;line-height:1.6;">
                Votre espace <strong>NexusRH CI</strong> pour <strong>${tenantName}</strong> est prêt.
                Vous êtes maintenant administrateur de votre organisation sur la plateforme.
              </p>

              <!-- Credentials box -->
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:24px;margin-bottom:28px;">
                <p style="margin:0 0 16px;font-size:14px;font-weight:600;color:#374151;">Vos identifiants de connexion</p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                      <span style="font-size:13px;color:#6b7280;">Adresse email</span>
                    </td>
                    <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                      <span style="font-size:13px;font-weight:600;color:#111827;">${to}</span>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0 0;">
                      <span style="font-size:13px;color:#6b7280;">Mot de passe temporaire</span>
                    </td>
                    <td style="padding:8px 0 0;text-align:right;">
                      <code style="font-size:15px;font-weight:700;color:${primaryColor};background:${primaryColor}15;padding:4px 10px;border-radius:6px;letter-spacing:1px;">${tempPassword}</code>
                    </td>
                  </tr>
                </table>
              </div>

              <!-- Plan badge -->
              <div style="background:${primaryColor}12;border:1px solid ${primaryColor}30;border-radius:8px;padding:12px 16px;margin-bottom:28px;display:flex;align-items:center;gap:8px;">
                <span style="font-size:13px;color:${primaryColor};font-weight:600;">Plan ${plan.charAt(0).toUpperCase() + plan.slice(1)}</span>
                <span style="font-size:13px;color:#6b7280;">— Accès complet à toutes les fonctionnalités RH CI</span>
              </div>

              <!-- CTA -->
              <div style="text-align:center;margin-bottom:32px;">
                <a href="${loginUrl}" style="display:inline-block;background:${primaryColor};color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:16px;font-weight:600;letter-spacing:0.3px;">
                  Accéder à mon espace →
                </a>
              </div>

              <!-- Security note -->
              <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;">
                <p style="margin:0;font-size:13px;color:#92400e;">
                  🔒 <strong>Sécurité :</strong> Changez votre mot de passe dès votre première connexion dans <em>Mon profil → Sécurité</em>.
                </p>
              </div>
            </td>
          </tr>

          <!-- Features -->
          <tr>
            <td style="padding:0 40px 32px;">
              <p style="margin:0 0 16px;font-size:14px;font-weight:600;color:#374151;">Ce que vous pouvez faire dès maintenant :</p>
              <table width="100%" cellpadding="0" cellspacing="0">
                ${[
                  ['👤', 'Ajouter vos employés et gérer les contrats OHADA'],
                  ['💰', 'Lancer votre premier calcul de paie (CNPS 2024 + ITS/DGI)'],
                  ['📱', 'Configurer le paiement Mobile Money (Wave, MTN, Orange)'],
                  ['📊', 'Générer vos déclarations CNPS et DISA'],
                  ['🤖', 'Utiliser l\'assistant IA calibré droit social ivoirien'],
                ].map(([icon, text]) => `
                <tr>
                  <td style="padding:6px 0;vertical-align:top;width:28px;">
                    <span style="font-size:16px;">${icon}</span>
                  </td>
                  <td style="padding:6px 0;">
                    <span style="font-size:14px;color:#374151;">${text}</span>
                  </td>
                </tr>`).join('')}
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:24px 40px;text-align:center;">
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
                Une question ? Contactez notre support
              </p>
              <p style="margin:0;font-size:13px;">
                <a href="https://wa.me/2250709320594" style="color:${primaryColor};text-decoration:none;font-weight:600;">WhatsApp +225 07 09 32 05 94</a>
                &nbsp;·&nbsp;
                <a href="mailto:support@nexusrh-ci.com" style="color:${primaryColor};text-decoration:none;font-weight:600;">support@nexusrh-ci.com</a>
              </p>
              <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;">
                OpenLab Consulting · Cocody, Rivièra Faya Lauriers 8, Abidjan · Côte d'Ivoire
              </p>
              <p style="margin:4px 0 0;font-size:11px;color:#9ca3af;">
                NexusRH CI — Propulsé par Claude AI (Anthropic)
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  await getTransporter().sendMail({
    from: from || config.smtp.from,
    ...(replyTo ? { replyTo } : {}),
    to,
    subject: `🎉 Votre espace NexusRH CI est prêt — ${tenantName}`,
    html,
    text: `Bonjour ${firstName},\n\nVotre espace NexusRH CI pour ${tenantName} est prêt.\n\nEmail : ${to}\nMot de passe temporaire : ${tempPassword}\n\nConnectez-vous sur : ${loginUrl}\n\nOpenLab Consulting — support@nexusrh-ci.com`,
  })
}

export async function sendEmployeeWelcomeEmail(params: {
  to: string; firstName: string; lastName: string
  tenantName: string; primaryColor: string; loginUrl: string; tempPassword: string
  logoUrl?: string | null; from?: string | null; replyTo?: string | null
}): Promise<void> {
  const { to, firstName, lastName, tenantName, primaryColor, loginUrl, tempPassword, logoUrl, from, replyTo } = params
  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
      <tr>${brandHeader(tenantName, 'NexusRH CI — Espace employé', primaryColor, logoUrl)}</tr>
      <tr><td style="padding:32px;">
        <h2 style="margin:0 0 12px;font-size:22px;color:#111;">Bonjour ${firstName} ${lastName} 👋</h2>
        <p style="margin:0 0 24px;font-size:15px;color:#374151;line-height:1.6;">
          Votre compte <strong>NexusRH CI</strong> a été créé. Accédez à votre espace employé pour consulter vos bulletins de paie, gérer vos absences et vos notes de frais.
        </p>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin-bottom:24px;">
          <p style="margin:0 0 12px;font-weight:600;font-size:14px;color:#374151;">Vos identifiants</p>
          <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">Email : <strong style="color:#111;">${to}</strong></p>
          <p style="margin:0;font-size:13px;color:#6b7280;">Mot de passe temporaire : <code style="background:${primaryColor}15;color:${primaryColor};font-size:15px;font-weight:700;padding:3px 10px;border-radius:6px;">${tempPassword}</code></p>
        </div>
        <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;margin-bottom:24px;">
          <p style="margin:0;font-size:13px;color:#92400e;">🔒 <strong>Important :</strong> Vous devrez changer ce mot de passe lors de votre première connexion.</p>
        </div>
        <div style="text-align:center;">
          <a href="${loginUrl}" style="display:inline-block;background:${primaryColor};color:#fff;text-decoration:none;padding:13px 32px;border-radius:8px;font-size:15px;font-weight:600;">
            Accéder à mon espace →
          </a>
        </div>
      </td></tr>
      <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center;">
        <p style="margin:0;font-size:12px;color:#9ca3af;">OpenLab Consulting · support@nexusrh-ci.com · +225 07 09 32 05 94</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`

  await getTransporter().sendMail({
    from: from || config.smtp.from,
    ...(replyTo ? { replyTo } : {}),
    to,
    subject: `Votre accès NexusRH CI — ${tenantName}`,
    html,
    text: `Bonjour ${firstName},\nVotre compte a été créé.\nEmail : ${to}\nMot de passe temporaire : ${tempPassword}\nConnexion : ${loginUrl}\nVous devrez changer ce mot de passe à la première connexion.`,
  })
}

// Email de bienvenue d'un CABINET de recrutement (envoyé au 1er owner par le
// super_admin). Expéditeur = OpenLab par défaut (config.smtp.from).
export async function sendWelcomeAgencyEmail(params: {
  to: string
  firstName: string
  lastName: string
  agencyName: string
  primaryColor: string
  loginUrl: string
  tempPassword: string
  logoUrl?: string | null
}): Promise<void> {
  const { to, firstName, lastName, agencyName, primaryColor, loginUrl, tempPassword, logoUrl } = params
  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      <tr>${brandHeader(agencyName, 'Cabinet de recrutement · NexusRH CI', primaryColor, logoUrl)}</tr>
      <tr><td style="padding:40px;">
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:600;">BIENVENUE</p>
        <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#111827;">Bonjour ${firstName} ${lastName} 👋</h1>
        <p style="margin:0 0 24px;font-size:16px;color:#374151;line-height:1.6;">
          Votre cabinet <strong>${agencyName}</strong> est désormais actif sur <strong>NexusRH CI</strong>.
          Vous pouvez gérer vos entreprises clientes, inviter vos recruteurs et piloter le recrutement.
        </p>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:24px;margin-bottom:28px;">
          <p style="margin:0 0 16px;font-size:14px;font-weight:600;color:#374151;">Vos identifiants de connexion</p>
          <p style="margin:0 0 6px;font-size:13px;color:#6b7280;">Email : <strong style="color:#111;">${to}</strong></p>
          <p style="margin:0;font-size:13px;color:#6b7280;">Mot de passe temporaire : <code style="background:${primaryColor}15;color:${primaryColor};font-size:15px;font-weight:700;padding:3px 10px;border-radius:6px;">${tempPassword}</code></p>
        </div>
        <div style="text-align:center;margin-bottom:28px;">
          <a href="${loginUrl}" style="display:inline-block;background:${primaryColor};color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:16px;font-weight:600;">Accéder à mon cabinet →</a>
        </div>
        <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;">
          <p style="margin:0;font-size:13px;color:#92400e;">🔒 <strong>Sécurité :</strong> changez ce mot de passe dès votre première connexion.</p>
        </div>
      </td></tr>
      <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:24px 40px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#9ca3af;">OpenLab Consulting · Abidjan · NexusRH CI</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`

  await getTransporter().sendMail({
    from: config.smtp.from,
    to,
    subject: `🎉 Votre cabinet est actif sur NexusRH CI — ${agencyName}`,
    html,
    text: `Bonjour ${firstName},\n\nVotre cabinet ${agencyName} est actif sur NexusRH CI.\n\nEmail : ${to}\nMot de passe temporaire : ${tempPassword}\n\nConnectez-vous sur : ${loginUrl}\n\nOpenLab Consulting`,
  })
}

export async function sendPasswordResetEmail(params: {
  to: string
  firstName: string
  tempPassword: string
  loginUrl: string
  tenantName: string
  primaryColor: string
  tenantCity?: string | null
}): Promise<void> {
  const { to, firstName, tempPassword, loginUrl, tenantName, primaryColor, tenantCity } = params

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Réinitialisation de votre mot de passe — NexusRH CI</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background:${primaryColor};padding:32px 40px;text-align:center;">
              <div style="display:inline-flex;align-items:center;gap:12px;">
                <div style="width:48px;height:48px;background:rgba(255,255,255,0.2);border-radius:10px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;color:#fff;">
                  ${tenantName.slice(0, 2).toUpperCase()}
                </div>
                <div style="text-align:left;">
                  <p style="margin:0;font-size:20px;font-weight:700;color:#fff;">${tenantName}</p>
                  <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.8);">${tenantCity ? `${tenantCity} · ` : ''}NexusRH CI</p>
                </div>
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px;">
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:600;">RÉINITIALISATION</p>
              <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#111827;">
                Bonjour ${firstName} 🔑
              </h1>
              <p style="margin:0 0 24px;font-size:16px;color:#374151;line-height:1.6;">
                Le mot de passe de votre compte administrateur sur <strong>${tenantName}</strong> a été réinitialisé.
                Utilisez le mot de passe temporaire ci-dessous pour vous reconnecter.
              </p>

              <!-- Credentials box -->
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:24px;margin-bottom:28px;">
                <p style="margin:0 0 16px;font-size:14px;font-weight:600;color:#374151;">Vos nouveaux identifiants</p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">
                      <span style="font-size:13px;color:#6b7280;">Adresse email</span>
                    </td>
                    <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">
                      <span style="font-size:13px;font-weight:600;color:#111827;">${to}</span>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0 0;">
                      <span style="font-size:13px;color:#6b7280;">Mot de passe temporaire</span>
                    </td>
                    <td style="padding:8px 0 0;text-align:right;">
                      <code style="font-size:15px;font-weight:700;color:${primaryColor};background:${primaryColor}15;padding:4px 10px;border-radius:6px;letter-spacing:1px;">${tempPassword}</code>
                    </td>
                  </tr>
                </table>
              </div>

              <!-- CTA -->
              <div style="text-align:center;margin-bottom:32px;">
                <a href="${loginUrl}" style="display:inline-block;background:${primaryColor};color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:16px;font-weight:600;letter-spacing:0.3px;">
                  Se connecter maintenant →
                </a>
              </div>

              <!-- Security note -->
              <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;margin-bottom:16px;">
                <p style="margin:0;font-size:13px;color:#92400e;">
                  🔒 <strong>Sécurité :</strong> Changez ce mot de passe temporaire dès votre prochaine connexion dans <em>Mon profil → Sécurité</em>.
                </p>
              </div>

              <!-- Warning if not you -->
              <div style="background:#fee2e2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;">
                <p style="margin:0;font-size:13px;color:#991b1b;">
                  ⚠️ Vous n'êtes pas à l'origine de cette demande ? Contactez immédiatement le support OpenLab via WhatsApp ou email.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:24px 40px;text-align:center;">
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
                Une question ? Contactez notre support
              </p>
              <p style="margin:0;font-size:13px;">
                <a href="https://wa.me/2250709320594" style="color:${primaryColor};text-decoration:none;font-weight:600;">WhatsApp +225 07 09 32 05 94</a>
                &nbsp;·&nbsp;
                <a href="mailto:support@nexusrh-ci.com" style="color:${primaryColor};text-decoration:none;font-weight:600;">support@nexusrh-ci.com</a>
              </p>
              <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;">
                OpenLab Consulting · Cocody, Rivièra Faya Lauriers 8, Abidjan · Côte d'Ivoire
              </p>
              <p style="margin:4px 0 0;font-size:11px;color:#9ca3af;">
                NexusRH CI — La RH Intelligente, au service de l'Afrique qui avance
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  await getTransporter().sendMail({
    from: config.smtp.from,
    to,
    subject: `🔑 Réinitialisation de votre mot de passe — ${tenantName}`,
    html,
    text: `Bonjour ${firstName},\n\nLe mot de passe de votre compte administrateur sur ${tenantName} a été réinitialisé.\n\nEmail : ${to}\nMot de passe temporaire : ${tempPassword}\n\nConnectez-vous sur : ${loginUrl}\n\nChangez ce mot de passe dès votre prochaine connexion.\n\nOpenLab Consulting — support@nexusrh-ci.com`,
  })
}

/**
 * Self-service forgot-password : envoie un LIEN magique (avec token unique-use,
 * TTL 15 min) que l'utilisateur clique pour ouvrir /reset-password?token=...
 *
 * À distinguer de sendPasswordResetEmail() ci-dessus qui envoie un MOT DE PASSE
 * TEMPORAIRE généré côté serveur (utilisé par le reset administratif super_admin).
 */
export async function sendPasswordResetLinkEmail(params: {
  to: string
  firstName: string
  resetUrl: string         // ex: https://nexusrh.openlabconsulting.com/reset-password?token=XYZ
  expiresInMinutes: number // 15 par défaut
}): Promise<void> {
  const { to, firstName, resetUrl, expiresInMinutes } = params

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Réinitialiser votre mot de passe — NexusRH CI</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#E85D04;padding:32px 40px;text-align:center;">
              <p style="margin:0;font-size:22px;font-weight:700;color:#fff;">NexusRH CI</p>
              <p style="margin:4px 0 0;font-size:13px;color:rgba(255,255,255,0.85);">La RH Intelligente d'Abidjan</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:600;">RÉINITIALISATION DEMANDÉE</p>
              <h1 style="margin:0 0 16px;font-size:26px;font-weight:700;color:#111827;">
                Bonjour ${firstName} 👋
              </h1>
              <p style="margin:0 0 24px;font-size:16px;color:#374151;line-height:1.6;">
                Nous avons reçu une demande de réinitialisation de votre mot de passe.
                Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe.
                <strong>Ce lien est valable ${expiresInMinutes} minutes</strong> et ne peut être utilisé qu'une seule fois.
              </p>

              <div style="text-align:center;margin-bottom:28px;">
                <a href="${resetUrl}" style="display:inline-block;background:#E85D04;color:#fff;text-decoration:none;padding:14px 36px;border-radius:8px;font-size:16px;font-weight:600;letter-spacing:0.3px;">
                  Réinitialiser mon mot de passe →
                </a>
              </div>

              <div style="background:#fff8eb;border-left:4px solid #f59e0b;padding:16px 20px;border-radius:6px;margin-bottom:24px;">
                <p style="margin:0;font-size:13px;color:#78350f;line-height:1.6;">
                  <strong>Vous n'avez pas demandé cette réinitialisation ?</strong><br>
                  Ignorez ce message. Votre mot de passe actuel reste inchangé. Pour toute question, contactez votre administrateur.
                </p>
              </div>

              <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5;text-align:center;">
                Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :<br>
                <span style="word-break:break-all;color:#6b7280;">${resetUrl}</span>
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#f9fafb;padding:24px 40px;text-align:center;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#6b7280;line-height:1.5;">
                OpenLab Consulting — Cocody, Rivièra Faya Lauriers 8, Abidjan<br>
                <a href="mailto:support@nexusrh-ci.com" style="color:#E85D04;text-decoration:none;">support@nexusrh-ci.com</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  await getTransporter().sendMail({
    from: config.smtp.from,
    to,
    subject: `🔑 Réinitialisez votre mot de passe NexusRH CI`,
    html,
    text: `Bonjour ${firstName},\n\nNous avons reçu une demande de réinitialisation de votre mot de passe NexusRH CI.\n\nOuvrez ce lien pour choisir un nouveau mot de passe (valable ${expiresInMinutes} minutes, usage unique) :\n${resetUrl}\n\nSi vous n'avez pas demandé cette réinitialisation, ignorez ce message. Votre mot de passe actuel reste inchangé.\n\nOpenLab Consulting — support@nexusrh-ci.com`,
  })
}
