/**
 * Piste d'audit OPPOSABLE — chaînage cryptographique de `audit_log`.
 *
 * ── Le problème ─────────────────────────────────────────────────────────────
 * Une table de journal, aussi complète soit-elle, ne prouve rien : qui dispose
 * d'un accès à la base peut modifier une ligne ou en supprimer une, et la
 * piste reste parfaitement cohérente. En cas de litige — un licenciement
 * contesté, un contrôle CNPS, une réquisition — « notre journal dit que… » ne
 * vaut que si l'on peut démontrer que le journal n'a pas été retouché.
 *
 * ── Le mécanisme ────────────────────────────────────────────────────────────
 * Chaque entrée porte l'empreinte SHA-256 de son contenu ET celle de l'entrée
 * précédente (`prev_hash`). Les entrées forment donc une chaîne : modifier ou
 * supprimer une ligne du passé invalide toutes les empreintes suivantes, et
 * c'est vérifiable par un recalcul (cf. `services/audit-integrity.service`).
 * Falsifier sans laisser de trace exigerait de recalculer la chaîne entière
 * jusqu'à la dernière entrée — ce que le contrôle détecte en comparant la
 * dernière empreinte à celle d'un export antérieur, déjà remis au tiers.
 *
 * Le calcul se fait dans un TRIGGER, pas dans le code applicatif, pour trois
 * raisons :
 *   - il couvre TOUTE écriture, y compris un INSERT passé directement en SQL
 *     (psql, script de reprise, autre service) : rien n'échappe à la chaîne ;
 *   - il est atomique avec l'insertion — aucune fenêtre où une entrée existe
 *     sans empreinte ;
 *   - `sha256()` est natif depuis PostgreSQL 11 : aucune extension à installer
 *     (pgcrypto n'est pas garanti sur une base managée).
 *
 * Un verrou consultatif de transaction sérialise les écritures concurrentes :
 * sans lui, deux insertions simultanées liraient la même entrée précédente et
 * la chaîne FOURCHERAIT. Le volume d'audit ne rend pas ce verrou coûteux, et il
 * est pris par schéma — un tenant n'attend jamais à cause d'un autre.
 *
 * ── Ce que ce chaînage ne fait pas ──────────────────────────────────────────
 * Il ne protège pas contre la non-écriture (une action jamais journalisée ne
 * laisse pas de trou dans la chaîne) ni contre un effacement TOTAL de la table.
 * C'est l'export signé, remis périodiquement à un tiers, qui ferme ces deux
 * portes : il fige la dernière empreinte et le nombre d'entrées à une date.
 *
 * Partagé par le provisioning et la migration lazy (idempotent).
 */

/** Colonnes de chaînage, ajoutées à `audit_log` (tenant ou plateforme). */
export function auditChainStatements(schemaName: string): string[] {
  const s = `"${schemaName}"`
  const fn = `${s}.audit_log_chain`
  return [
    // `seq` donne l'ORDRE de la chaîne : `created_at` ne suffit pas (deux
    // entrées peuvent partager l'horodatage à la microseconde près, et une
    // horloge peut reculer).
    `ALTER TABLE ${s}.audit_log ADD COLUMN IF NOT EXISTS seq bigserial`,
    `ALTER TABLE ${s}.audit_log ADD COLUMN IF NOT EXISTS prev_hash char(64)`,
    `ALTER TABLE ${s}.audit_log ADD COLUMN IF NOT EXISTS entry_hash char(64)`,
    // L'agent utilisateur complète l'imputabilité d'un accès (poste, client).
    `ALTER TABLE ${s}.audit_log ADD COLUMN IF NOT EXISTS user_agent text`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "${schemaName}_audit_log_seq_idx" ON ${s}.audit_log(seq)`,

    // Empreinte d'une entrée : tous les champs qui FONT la preuve, dans un
    // ordre figé, séparés par un caractère qui ne peut pas apparaître dans les
    // valeurs (\\x1f) — sans séparateur, « ab|c » et « a|bc » auraient la même
    // empreinte, et deux entrées différentes deviendraient interchangeables.
    `CREATE OR REPLACE FUNCTION ${fn}_digest(
       p_prev char(64), p_id uuid, p_user_id uuid, p_action varchar, p_entity varchar,
       p_entity_id uuid, p_changes jsonb, p_ip varchar, p_created_at timestamptz
     ) RETURNS char(64) LANGUAGE sql IMMUTABLE AS $$
       SELECT encode(sha256(convert_to(
         concat_ws(chr(31),
           coalesce(p_prev, ''), p_id::text, coalesce(p_user_id::text, ''),
           p_action, p_entity, coalesce(p_entity_id::text, ''),
           coalesce(p_changes::text, '{}'), coalesce(p_ip, ''),
           to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
         ), 'UTF8')), 'hex')
     $$`,

    `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
     DECLARE v_prev char(64);
     BEGIN
       -- Sérialise les écritures concurrentes de CE schéma : sans ce verrou,
       -- deux insertions simultanées liraient la même entrée précédente.
       PERFORM pg_advisory_xact_lock(hashtext('${schemaName}.audit_log'));
       SELECT entry_hash INTO v_prev
         FROM ${s}.audit_log
        WHERE entry_hash IS NOT NULL
        ORDER BY seq DESC LIMIT 1;
       NEW.prev_hash := v_prev;
       NEW.entry_hash := ${fn}_digest(
         v_prev, NEW.id, NEW.user_id, NEW.action, NEW.entity,
         NEW.entity_id, NEW.changes, NEW.ip_address, NEW.created_at);
       RETURN NEW;
     END $$`,

    `DROP TRIGGER IF EXISTS audit_log_chain_trg ON ${s}.audit_log`,
    `CREATE TRIGGER audit_log_chain_trg
       BEFORE INSERT ON ${s}.audit_log
       FOR EACH ROW EXECUTE FUNCTION ${fn}()`,

    // La piste est en AJOUT SEUL. Une entrée ne se corrige JAMAIS : un UPDATE
    // échoue, sans exception possible.
    `CREATE OR REPLACE FUNCTION ${fn}_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       RAISE EXCEPTION 'audit_log est en ajout seul : une entrée ne se modifie pas (piste opposable)';
     END $$`,
    `DROP TRIGGER IF EXISTS audit_log_no_update_trg ON ${s}.audit_log`,
    `CREATE TRIGGER audit_log_no_update_trg
       BEFORE UPDATE ON ${s}.audit_log
       FOR EACH ROW EXECUTE FUNCTION ${fn}_no_update()`,

    // La suppression, elle, doit rester possible : une rétention bornée est une
    // obligation, pas un confort. Mais elle ne passe QUE par la fonction de
    // purge, qui écrit un marqueur avant de supprimer. Le garde-fou s'appuie
    // sur un drapeau de TRANSACTION que seule cette fonction pose : un DELETE
    // tapé dans psql échoue, y compris sous le rôle propriétaire.
    `CREATE OR REPLACE FUNCTION ${fn}_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF coalesce(current_setting('nexusrh.audit_purge', true), '') <> 'on' THEN
         RAISE EXCEPTION 'Suppression directe interdite : passez par audit_log_purge(), qui laisse un marqueur';
       END IF;
       RETURN OLD;
     END $$`,
    `DROP TRIGGER IF EXISTS audit_log_no_delete_trg ON ${s}.audit_log`,
    `CREATE TRIGGER audit_log_no_delete_trg
       BEFORE DELETE ON ${s}.audit_log
       FOR EACH ROW EXECUTE FUNCTION ${fn}_no_delete()`,
  ]
}

/**
 * Purge de rétention : seule voie de suppression autorisée.
 *
 * Elle écrit un MARQUEUR avant de supprimer — combien d'entrées, jusqu'à quelle
 * date, et l'empreinte de la dernière entrée supprimée — puis pose le drapeau
 * de transaction que le garde-fou DELETE exige. La chaîne reste vérifiable à
 * partir du marqueur, et le trou est documenté au lieu d'être invisible.
 *
 * `p_keep_days <= 0` signifie « conservation sans limite » : rien n'est
 * supprimé. C'est le défaut, parce que choisir une durée de conservation est
 * une décision juridique du client, pas un réglage technique.
 */
export function auditPurgeFunctionStatements(schemaName: string): string[] {
  const s = `"${schemaName}"`
  return [
    `CREATE OR REPLACE FUNCTION ${s}.audit_log_purge(p_keep_days int)
       RETURNS TABLE(purged bigint, boundary timestamptz) LANGUAGE plpgsql AS $$
     DECLARE
       v_cutoff timestamptz := now() - make_interval(days => p_keep_days);
       v_count  bigint;
       v_last   char(64);
       v_max    timestamptz;
     BEGIN
       IF p_keep_days IS NULL OR p_keep_days <= 0 THEN
         RETURN QUERY SELECT 0::bigint, NULL::timestamptz;  -- 0 = conservation sans limite
         RETURN;
       END IF;
       SELECT count(*), max(created_at) INTO v_count, v_max
         FROM ${s}.audit_log WHERE created_at < v_cutoff;
       IF v_count = 0 THEN
         RETURN QUERY SELECT 0::bigint, NULL::timestamptz;
         RETURN;
       END IF;
       SELECT entry_hash INTO v_last
         FROM ${s}.audit_log WHERE created_at < v_cutoff ORDER BY seq DESC LIMIT 1;
       -- Marqueur d'abord : si la suppression échoue, il reste une trace de la
       -- tentative ; si elle réussit, le trou est expliqué.
       INSERT INTO ${s}.audit_log (user_id, action, entity, changes)
       VALUES (NULL, 'audit.purged', 'audit_log',
               jsonb_build_object('purged', v_count, 'until', v_max,
                                  'keepDays', p_keep_days, 'lastPurgedHash', v_last));
       -- Drapeau local a la transaction : le garde-fou DELETE n'accepte que ce
       -- chemin, et le drapeau retombe a la fin de la transaction.
       PERFORM set_config('nexusrh.audit_purge', 'on', true);
       DELETE FROM ${s}.audit_log WHERE created_at < v_cutoff;
       PERFORM set_config('nexusrh.audit_purge', 'off', true);
       RETURN QUERY SELECT v_count, v_max;
     END $$`,
  ]
}
