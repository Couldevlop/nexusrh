/**
 * Backup job — pg_dump de la base entière, upload S3/MinIO, rotation 30 jours.
 * Planifié chaque nuit à 3h via le worker index.ts.
 */
import { Worker, Job } from 'bullmq'
import { exec } from 'child_process'
import { promisify } from 'util'
import { createReadStream, statSync, unlinkSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import crypto from 'crypto'
import pino from 'pino'
import { Pool } from 'pg'
import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { redisConnection } from '../queues'

const execAsync = promisify(exec)
const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' })

const DB_URL = process.env['DATABASE_URL'] ?? ''
const S3_ENDPOINT = process.env['S3_ENDPOINT'] ?? 'http://localhost:9000'
const S3_ACCESS_KEY = process.env['S3_ACCESS_KEY'] ?? 'minioadmin'
const S3_SECRET_KEY = process.env['S3_SECRET_KEY'] ?? 'minioadmin'
const S3_BUCKET = process.env['S3_BUCKET'] ?? 'nexusrh'
const S3_REGION = process.env['S3_REGION'] ?? 'eu-west-1'
const BACKUP_RETENTION_DAYS = parseInt(process.env['BACKUP_RETENTION_DAYS'] ?? '30', 10)

const pool = new Pool({ connectionString: DB_URL, max: 2 })

const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] === 'true',
})

export const backupWorker = new Worker(
  'backup',
  async (job: Job) => {
    const startTime = Date.now()
    const backupId = crypto.randomUUID()
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `nexusrh-backup-${dateStr}.sql`
    const filePath = join(tmpdir(), filename)
    const s3Key = `backups/${filename}`

    logger.info({ jobId: job.id, backupId }, 'Démarrage backup PostgreSQL')

    // Enregistrer le job en base
    await pool.query(
      `INSERT INTO platform.backup_jobs (id, status) VALUES ($1, 'running')`,
      [backupId],
    ).catch(() => {}) // Silencieux si table n'existe pas encore

    try {
      // ── 1. pg_dump ─────────────────────────────────────────────────────────
      const pgDumpCmd = `pg_dump "${DB_URL}" --no-password --format=plain --no-acl --no-owner -f "${filePath}"`
      await execAsync(pgDumpCmd)
      logger.info({ filename }, 'pg_dump terminé')

      const fileSize = statSync(filePath).size
      logger.info({ fileSize: `${Math.round(fileSize / 1024)}KB` }, 'Taille fichier backup')

      // ── 2. Upload S3/MinIO ─────────────────────────────────────────────────
      const fileStream = createReadStream(filePath)
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: fileStream,
        ContentType: 'application/sql',
        Metadata: {
          'nexusrh-backup-id': backupId,
          'nexusrh-created-at': new Date().toISOString(),
        },
      }))
      logger.info({ s3Key }, 'Backup uploadé sur S3/MinIO')

      // ── 3. Nettoyage fichier temporaire ────────────────────────────────────
      if (existsSync(filePath)) unlinkSync(filePath)

      // ── 4. Rotation — supprimer backups > RETENTION_DAYS ─────────────────
      await rotateOldBackups(s3Key)

      const durationMs = Date.now() - startTime

      // ── 5. Mise à jour statut en base ─────────────────────────────────────
      await pool.query(
        `UPDATE platform.backup_jobs
         SET status='completed', file_key=$1, file_size=$2, duration_ms=$3, completed_at=NOW()
         WHERE id=$4`,
        [s3Key, fileSize, durationMs, backupId],
      ).catch(() => {})

      logger.info({ backupId, durationMs, s3Key }, `Backup terminé en ${durationMs}ms`)
      return { backupId, s3Key, fileSize, durationMs }
    } catch (err) {
      // Nettoyage fichier temporaire en cas d'erreur
      if (existsSync(filePath)) unlinkSync(filePath)

      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error({ err, backupId }, 'Backup échoué')

      await pool.query(
        `UPDATE platform.backup_jobs SET status='failed', error=$1, completed_at=NOW() WHERE id=$2`,
        [errorMsg, backupId],
      ).catch(() => {})

      throw err
    }
  },
  {
    connection: redisConnection,
    concurrency: 1,
  },
)

async function rotateOldBackups(currentKey: string): Promise<void> {
  try {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - BACKUP_RETENTION_DAYS)

    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: 'backups/',
    }))

    const toDelete = (listed.Contents ?? []).filter((obj) => {
      if (!obj.Key || obj.Key === currentKey) return false
      return obj.LastModified && obj.LastModified < cutoffDate
    })

    for (const obj of toDelete) {
      await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key! }))
      logger.info({ key: obj.Key }, 'Ancien backup supprimé (rotation)')
    }

    if (toDelete.length > 0) {
      logger.info({ count: toDelete.length }, `${toDelete.length} ancien(s) backup(s) supprimé(s)`)
    }
  } catch (err) {
    logger.warn({ err }, 'Rotation backups échouée (non bloquant)')
  }
}

backupWorker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, result }, 'Backup job completed')
})

backupWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'Backup job failed')
})
