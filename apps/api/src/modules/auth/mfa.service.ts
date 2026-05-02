import { authenticator } from 'otplib'
import QRCode from 'qrcode'
import { config } from '../../config'

authenticator.options = {
  window: 1,
}

export function generateMfaSecret(): string {
  return authenticator.generateSecret()
}

export function verifyMfaToken(token: string, secret: string): boolean {
  return authenticator.verify({ token, secret })
}

export async function generateMfaQrCode(
  email: string,
  secret: string
): Promise<string> {
  const otpAuthUrl = authenticator.keyuri(email, config.mfa.issuer, secret)
  return QRCode.toDataURL(otpAuthUrl)
}

export function generateBackupCodes(count = 8): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const code = Math.random().toString(36).substring(2, 10).toUpperCase()
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`)
  }
  return codes
}
