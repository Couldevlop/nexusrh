import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { config } from '../config'
import { logger } from '../utils/logger'
import crypto from 'crypto'
import path from 'path'

let s3Client: S3Client | null = null

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: config.storage.endpoint,
      credentials: {
        accessKeyId: config.storage.accessKey,
        secretAccessKey: config.storage.secretKey,
      },
      region: config.storage.region,
      forcePathStyle: config.storage.forcePathStyle,
    })
  }
  return s3Client
}

export async function uploadFile(
  fileBuffer: Buffer,
  originalFilename: string,
  folder: string,
  mimeType: string
): Promise<{ key: string; url: string; size: number }> {
  const ext = path.extname(originalFilename)
  const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`
  const key = `${folder}/${uniqueName}`

  try {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: config.storage.bucket,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType,
        ContentLength: fileBuffer.length,
      })
    )

    const url = `${config.storage.endpoint}/${config.storage.bucket}/${key}`
    logger.info({ key, size: fileBuffer.length }, 'Fichier uploadé')

    return { key, url, size: fileBuffer.length }
  } catch (err) {
    logger.error({ err, key }, 'Erreur upload fichier')
    throw err
  }
}

export async function getSignedDownloadUrl(
  key: string,
  expiresInSeconds = 3600
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
  })
  return getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds })
}

export async function getSignedUploadUrl(
  key: string,
  mimeType: string,
  expiresInSeconds = 300
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
    ContentType: mimeType,
  })
  return getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds })
}

export async function deleteFile(key: string): Promise<void> {
  try {
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: config.storage.bucket,
        Key: key,
      })
    )
    logger.info({ key }, 'Fichier supprimé')
  } catch (err) {
    logger.error({ err, key }, 'Erreur suppression fichier')
    throw err
  }
}

export async function fileExists(key: string): Promise<boolean> {
  try {
    await getS3Client().send(
      new HeadObjectCommand({
        Bucket: config.storage.bucket,
        Key: key,
      })
    )
    return true
  } catch {
    return false
  }
}

export function getPublicUrl(key: string): string {
  return `${config.storage.endpoint}/${config.storage.bucket}/${key}`
}
