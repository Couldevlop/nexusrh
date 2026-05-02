import nodemailer from 'nodemailer'
import mjml2html from 'mjml'
import { config } from '../config'
import { logger } from '../utils/logger'

let transporter: nodemailer.Transporter | null = null

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    const isGmail = config.email.host?.includes('gmail')
    transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure, // false = STARTTLS on port 587
      auth: config.email.user
        ? { user: config.email.user, pass: config.email.pass }
        : undefined,
      // Gmail with App Password requires these options
      ...(isGmail && {
        tls: { rejectUnauthorized: false },
        requireTLS: true,
      }),
    })
  }
  return transporter
}

interface EmailOptions {
  to: string | string[]
  subject: string
  html?: string
  text?: string
  mjml?: string
  attachments?: Array<{
    filename: string
    content: Buffer | string
    contentType?: string
  }>
}

export async function sendEmail(options: EmailOptions): Promise<void> {
  try {
    let htmlContent = options.html

    if (options.mjml) {
      const { html, errors } = mjml2html(options.mjml)
      if (errors.length > 0) {
        logger.warn({ errors }, 'MJML compilation warnings')
      }
      htmlContent = html
    }

    const info = await getTransporter().sendMail({
      from: config.email.from,
      to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
      subject: options.subject,
      html: htmlContent,
      text: options.text,
      attachments: options.attachments,
    })

    logger.info({ messageId: info.messageId, to: options.to }, 'Email envoyé')
  } catch (err) {
    logger.error({ err, to: options.to }, 'Erreur envoi email')
    throw err
  }
}

export async function sendPaySlipEmail(
  to: string,
  employeeName: string,
  month: string,
  pdfBuffer: Buffer
): Promise<void> {
  const mjmlTemplate = `
<mjml>
  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#4F46E5" padding="20px">
      <mj-column>
        <mj-text color="white" font-size="24px" font-weight="bold">NexusRH</mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="white" padding="40px">
      <mj-column>
        <mj-text font-size="18px" font-weight="bold">Bulletin de paie disponible</mj-text>
        <mj-text>Bonjour ${employeeName},</mj-text>
        <mj-text>Votre bulletin de paie pour ${month} est disponible en pièce jointe.</mj-text>
        <mj-text>Vous pouvez également le consulter directement sur votre espace NexusRH.</mj-text>
        <mj-button background-color="#4F46E5" href="${config.app.url}/self-service/payslips">
          Voir mes bulletins
        </mj-button>
        <mj-text font-size="12px" color="#666">
          Ce message est généré automatiquement, merci de ne pas y répondre.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`

  await sendEmail({
    to,
    subject: `Votre bulletin de paie ${month} — NexusRH`,
    mjml: mjmlTemplate,
    attachments: [
      {
        filename: `bulletin-paie-${month}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  })
}

export async function sendAbsenceNotificationEmail(
  to: string,
  managerName: string,
  employeeName: string,
  absenceType: string,
  startDate: string,
  endDate: string,
  approvalUrl: string
): Promise<void> {
  const mjmlTemplate = `
<mjml>
  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#4F46E5" padding="20px">
      <mj-column>
        <mj-text color="white" font-size="24px" font-weight="bold">NexusRH</mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="white" padding="40px">
      <mj-column>
        <mj-text font-size="18px" font-weight="bold">Demande d'absence à approuver</mj-text>
        <mj-text>Bonjour ${managerName},</mj-text>
        <mj-text>${employeeName} a soumis une demande d'absence :</mj-text>
        <mj-table>
          <tr><td><strong>Type</strong></td><td>${absenceType}</td></tr>
          <tr><td><strong>Du</strong></td><td>${startDate}</td></tr>
          <tr><td><strong>Au</strong></td><td>${endDate}</td></tr>
        </mj-table>
        <mj-button background-color="#4F46E5" href="${approvalUrl}">
          Approuver / Refuser
        </mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`

  await sendEmail({
    to,
    subject: `Demande d'absence — ${employeeName}`,
    mjml: mjmlTemplate,
  })
}

interface TenantBranding {
  primaryColor?: string
  secondaryColor?: string
  logoUrl?: string
  logoInitials?: string
}

export async function sendWelcomeEmail(
  to: string,
  firstName: string,
  lastName: string,
  tenantName: string,
  loginUrl: string,
  temporaryPassword: string,
  branding?: TenantBranding,
): Promise<void> {
  const primary = branding?.primaryColor ?? '#4F46E5'
  const secondary = branding?.secondaryColor ?? '#818CF8'
  const initials = branding?.logoInitials ?? tenantName.slice(0, 2).toUpperCase()

  const logoBlock = branding?.logoUrl
    ? `<mj-image src="${branding.logoUrl}" width="80px" align="center" padding-bottom="8px" />`
    : `<mj-text align="center" padding-bottom="8px">
        <span style="display:inline-block;background:white;color:${primary};font-size:24px;font-weight:900;border-radius:12px;padding:10px 18px;letter-spacing:1px">${initials}</span>
       </mj-text>`

  const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-attributes>
      <mj-all font-family="'Segoe UI', Arial, sans-serif" />
    </mj-attributes>
    <mj-style>
      .credential-box { background:#F8FAFC; border-radius:10px; border-left:4px solid ${primary}; }
      .step { background:#F1F5F9; border-radius:8px; margin-bottom:8px; }
    </mj-style>
  </mj-head>
  <mj-body background-color="#EEF2FF">

    <!-- Header -->
    <mj-section background-color="${primary}" padding="30px 40px 20px">
      <mj-column>
        ${logoBlock}
        <mj-text color="white" font-size="26px" font-weight="bold" align="center" padding-top="0">
          ${tenantName}
        </mj-text>
        <mj-text color="rgba(255,255,255,0.85)" font-size="14px" align="center" padding-top="4px">
          Propulsé par NexusRH
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Welcome banner -->
    <mj-section background-color="${secondary}" padding="14px 40px">
      <mj-column>
        <mj-text color="white" font-size="15px" font-weight="600" align="center">
          🎉 Bienvenue — votre espace RH est prêt
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Main content -->
    <mj-section background-color="white" padding="40px 40px 24px" border-radius="0">
      <mj-column>
        <mj-text font-size="17px" font-weight="700" color="#0F172A" padding-bottom="8px">
          Bonjour ${firstName} ${lastName},
        </mj-text>
        <mj-text font-size="14px" color="#475569" line-height="26px" padding-bottom="20px">
          Votre compte a été créé sur la plateforme <strong>${tenantName}</strong>.<br />
          Vous trouverez ci-dessous vos identifiants de connexion et les étapes pour démarrer.
        </mj-text>

        <!-- Credentials box -->
        <mj-section css-class="credential-box" background-color="#F8FAFC" border-radius="10px" padding="20px 24px">
          <mj-column>
            <mj-text font-size="11px" font-weight="700" color="#94A3B8" letter-spacing="1px" padding-bottom="2px">
              IDENTIFIANTS DE CONNEXION
            </mj-text>
            <mj-divider border-color="#E2E8F0" padding="6px 0 14px" />
            <mj-text font-size="12px" color="#64748B" padding-bottom="2px">Adresse email</mj-text>
            <mj-text font-size="15px" font-weight="700" color="#1E293B" padding-top="0" padding-bottom="14px">
              ${to}
            </mj-text>
            <mj-text font-size="12px" color="#64748B" padding-bottom="2px">Mot de passe temporaire</mj-text>
            <mj-text font-size="22px" font-weight="800" color="${primary}" padding-top="0" letter-spacing="4px">
              ${temporaryPassword}
            </mj-text>
            <mj-text font-size="12px" color="#EF4444" font-weight="600" padding-top="8px">
              ⚠️ Ce mot de passe est à usage unique — vous serez invité à le changer dès la première connexion.
            </mj-text>
          </mj-column>
        </mj-section>

        <!-- CTA button -->
        <mj-button
          background-color="${primary}"
          href="${loginUrl}"
          border-radius="10px"
          font-size="15px"
          font-weight="700"
          padding="14px 32px"
          inner-padding="14px 32px"
          color="white"
        >
          Accéder à mon espace →
        </mj-button>

        <mj-text font-size="12px" color="#94A3B8" align="center" padding-top="4px">
          ${loginUrl}
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Steps section -->
    <mj-section background-color="#F8FAFC" padding="28px 40px">
      <mj-column>
        <mj-text font-size="14px" font-weight="700" color="#1E293B" padding-bottom="14px">
          📋 Vos 4 premières actions après connexion
        </mj-text>

        <mj-section css-class="step" background-color="#EEF2FF" border-radius="8px" padding="10px 14px">
          <mj-column>
            <mj-text font-size="13px" color="#3730A3">
              <strong>1.</strong> Changez votre mot de passe temporaire dans <em>Mon Profil &gt; Sécurité</em>
            </mj-text>
          </mj-column>
        </mj-section>

        <mj-section css-class="step" background-color="#F0FDF4" border-radius="8px" padding="10px 14px">
          <mj-column>
            <mj-text font-size="13px" color="#166534">
              <strong>2.</strong> Activez l'authentification à deux facteurs (2FA) via <em>Mon Profil &gt; Sécurité &gt; Activer le 2FA</em>
            </mj-text>
          </mj-column>
        </mj-section>

        <mj-section css-class="step" background-color="#FFF7ED" border-radius="8px" padding="10px 14px">
          <mj-column>
            <mj-text font-size="13px" color="#9A3412">
              <strong>3.</strong> Complétez vos informations personnelles (adresse, téléphone, IBAN)
            </mj-text>
          </mj-column>
        </mj-section>

        <mj-section css-class="step" background-color="#F0F9FF" border-radius="8px" padding="10px 14px">
          <mj-column>
            <mj-text font-size="13px" color="#0C4A6E">
              <strong>4.</strong> Consultez votre espace : absences, bulletins, formations, notes de frais
            </mj-text>
          </mj-column>
        </mj-section>
      </mj-column>
    </mj-section>

    <!-- Security notice -->
    <mj-section background-color="white" padding="16px 40px 28px">
      <mj-column>
        <mj-divider border-color="#E2E8F0" padding="0 0 16px" />
        <mj-text font-size="12px" color="#94A3B8" line-height="20px">
          🔒 <strong>Sécurité :</strong> Ne communiquez jamais vos identifiants. NexusRH ne vous demandera jamais
          votre mot de passe par email. Si vous n'êtes pas à l'origine de la création de ce compte,
          contactez immédiatement votre service RH.
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Footer -->
    <mj-section background-color="${primary}" padding="16px 40px">
      <mj-column>
        <mj-text font-size="11px" color="rgba(255,255,255,0.7)" align="center">
          ${tenantName} · Propulsé par NexusRH SIRH SaaS · Email généré automatiquement · Ne pas répondre
        </mj-text>
      </mj-column>
    </mj-section>

  </mj-body>
</mjml>`

  await sendEmail({
    to,
    subject: `[${tenantName}] Vos accès NexusRH — Identifiants de connexion`,
    mjml: mjmlTemplate,
  })
}

/**
 * Test de la connexion SMTP — envoie un email de test à l'adresse spécifiée.
 * Utilisé par le wizard d'onboarding et POST /platform/smtp/test.
 */
export async function testSmtpConnection(targetEmail: string): Promise<void> {
  if (!config.email.user || !config.email.host || config.email.host === 'smtp.example.com') {
    throw new Error('SMTP non configuré — définissez SMTP_HOST, SMTP_USER et SMTP_PASS dans le .env')
  }

  const transport = getTransporter()
  // Vérification de la connexion avant l'envoi
  await transport.verify()

  await transport.sendMail({
    from: config.email.from,
    to: targetEmail,
    subject: '✅ Test SMTP — NexusRH',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:32px">
        <div style="background:#4F46E5;border-radius:8px 8px 0 0;padding:20px;text-align:center">
          <h1 style="color:white;margin:0;font-size:22px">NexusRH</h1>
        </div>
        <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 8px 8px;padding:24px">
          <h2 style="color:#1F2937;font-size:16px">✅ Configuration SMTP validée</h2>
          <p style="color:#374151">Votre configuration email NexusRH fonctionne correctement.</p>
          <p style="color:#374151">Les emails d'invitation, bulletins et notifications seront envoyés depuis :</p>
          <p style="background:#EEF2FF;border-radius:4px;padding:8px 12px;color:#3730A3;font-weight:bold">
            ${config.email.from}
          </p>
          <p style="color:#6B7280;font-size:12px;margin-top:16px">
            Envoyé le ${new Date().toLocaleString('fr-FR')} depuis NexusRH Onboarding Wizard
          </p>
        </div>
      </div>`,
  })
}

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  resetUrl: string
): Promise<void> {
  const mjmlTemplate = `
<mjml>
  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#4F46E5" padding="20px">
      <mj-column>
        <mj-text color="white" font-size="24px" font-weight="bold">NexusRH</mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="white" padding="40px">
      <mj-column>
        <mj-text font-size="18px" font-weight="bold">Réinitialisation de mot de passe</mj-text>
        <mj-text>Bonjour ${name},</mj-text>
        <mj-text>Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton ci-dessous (valable 1 heure) :</mj-text>
        <mj-button background-color="#4F46E5" href="${resetUrl}">
          Réinitialiser mon mot de passe
        </mj-button>
        <mj-text font-size="12px" color="#666">
          Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`

  await sendEmail({
    to,
    subject: 'Réinitialisation de votre mot de passe NexusRH',
    mjml: mjmlTemplate,
  })
}
