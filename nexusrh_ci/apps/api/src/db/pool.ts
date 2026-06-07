/**
 * Pool PostgreSQL unique et partagé de tout le process API.
 *
 * Auparavant chaque module/service instanciait son propre `new Pool()` (~24
 * pools × poolMax) → risque réel d'épuisement des connexions PostgreSQL en
 * production. Désormais TOUT le code applicatif importe ce pool unique, borné
 * par DATABASE_POOL_MIN/MAX.
 *
 * Les tests qui mockent le module `pg` continuent de fonctionner : ce fichier
 * ne fait qu'appeler `new Pool()`, qui est intercepté par le mock du test.
 */
import { Pool } from 'pg'
import { config } from '../config.js'

export const pool = new Pool({
  connectionString: config.database.url,
  min: config.database.poolMin,
  max: config.database.poolMax,
})
