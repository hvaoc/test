package ysync

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// pgRecordStore makes the SERVER a full record client: it applies every field-level
// CRDT op into a Postgres LWW-REGISTER table, keeping the highest-HLC value per
// (entity, field, elem). Consequences:
//   - BOUNDED: a superseded edit overwrites its row in place; the store grows with
//     the number of live fields, not the number of edits ever made.
//   - QUERYABLE: the current areas/projects/tasks are real rows the server can read
//     (unlike the opaque op-log blob).
//   - FULL COPY on first login: a client at cursor 0 pulls every register = the whole
//     workspace; after that it pulls only rows whose seq advanced (deltas).
//
// Registers map the CRDT exactly (docs/architecture-1m.md §3):
//
//	presence op -> row (field='', elem='')            entity existence
//	field op    -> row (field=<name>, elem='')         per-field LWW register
//	set op      -> row (field=<name>, elem=<member>)   add-wins set element
type pgRecordStore struct {
	db *sql.DB
}

// NewPGRecordStore builds the materialized Postgres register store on an existing
// pool (share the PostgresPersistence pool). Set it on the hub via SetRecordStore.
func NewPGRecordStore(db *sql.DB) (RecordStore, error) { return newPGRecordStore(db) }

func newPGRecordStore(db *sql.DB) (*pgRecordStore, error) {
	const ddl = `
CREATE TABLE IF NOT EXISTS record_registers (
  scope   TEXT NOT NULL,
  kind    TEXT NOT NULL,
  entity  TEXT NOT NULL,
  field   TEXT NOT NULL DEFAULT '',
  elem    TEXT NOT NULL DEFAULT '',
  optype  TEXT NOT NULL,
  value   TEXT NOT NULL DEFAULT '',
  present BOOLEAN NOT NULL DEFAULT false,
  wall    BIGINT NOT NULL,
  ctr     BIGINT NOT NULL,
  node    TEXT NOT NULL,
  seq     BIGINT NOT NULL,
  PRIMARY KEY (scope, kind, entity, field, elem)
);
CREATE INDEX IF NOT EXISTS record_registers_scope_seq ON record_registers (scope, seq);
CREATE SEQUENCE IF NOT EXISTS record_seq;
-- deleted_at: the SERVER clock stamped when a row becomes a tombstone (present=false),
-- so the GC can forget it by age. NULL for live rows. Not the op's HLC (docs/tombstone-gc §05).
ALTER TABLE record_registers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS record_registers_deleted_at ON record_registers (deleted_at) WHERE deleted_at IS NOT NULL;
-- record_gc: one row per tenant holding the GC watermark = the highest seq the purge has
-- ever reclaimed. A client whose cursor sits below it has fallen behind the purge and must
-- full-reload (its incremental view could miss a delete). This is the client-facing contract.
CREATE TABLE IF NOT EXISTS record_gc (
  scope     TEXT PRIMARY KEY,
  watermark BIGINT NOT NULL DEFAULT 0
);
-- Backfill: tombstones that predate the deleted_at column carry NULL and would leak
-- forever. Stamp them once (now()) so they enter the retention window from the upgrade,
-- giving laggards 35 days to catch up. Field-VALUE rows (field<>'' AND elem='') are values,
-- never tombstones, so they're excluded and keep NULL. No-op after the first run.
UPDATE record_registers SET deleted_at = now()
 WHERE present = false AND deleted_at IS NULL AND (field = '' OR elem <> '');`
	if _, err := db.Exec(ddl); err != nil {
		return nil, err
	}
	return &pgRecordStore{db: db}, nil
}

// MigrateBlobLog replays any legacy append-only record blobs (the `rec:<scope>` rows
// the blob store wrote) into the materialized register store, so switching to the
// Postgres record engine collapses the existing op history into the current state.
// Idempotent (LWW upsert), so it's safe to run; callers gate it on an empty register
// table to avoid re-doing it every start.
func MigrateBlobLog(pp *PostgresPersistence, rs RecordStore) (int, error) {
	rows, err := pp.db.Query(`SELECT scope, data FROM sync_blobs WHERE scope LIKE 'rec:%'`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	migrated := 0
	for rows.Next() {
		var key string
		var data []byte
		if err := rows.Scan(&key, &data); err != nil {
			return migrated, err
		}
		var ops []json.RawMessage
		if json.Unmarshal(data, &ops) != nil || len(ops) == 0 {
			continue
		}
		if _, err := rs.Push(strings.TrimPrefix(key, "rec:"), ops); err != nil {
			return migrated, err
		}
		migrated++
	}
	return migrated, rows.Err()
}

// wireOp is the op JSON the clients speak (core/record.Op): field-level CRDT op with
// an HLC string "wall.ctr.node".
type wireOp struct {
	Type    string `json:"t"`
	Kind    string `json:"k"`
	ID      string `json:"i"`
	Field   string `json:"f,omitempty"`
	Elem    string `json:"e,omitempty"`
	Value   string `json:"v,omitempty"`
	Present bool   `json:"p,omitempty"`
	HLC     string `json:"h"`
}

func splitHLC(h string) (wall, ctr int64, node string) {
	parts := strings.SplitN(h, ".", 3)
	if len(parts) != 3 {
		return 0, 0, h
	}
	wall, _ = strconv.ParseInt(parts[0], 10, 64)
	ctr, _ = strconv.ParseInt(parts[1], 10, 64)
	return wall, ctr, parts[2]
}

// Push LWW-upserts each op: insert a new register, or overwrite the existing one only
// if the incoming HLC is strictly newer. A change bumps seq (for delta pulls); an
// older/duplicate op is a no-op. Returns the scope's current max seq.
func (s *pgRecordStore) Push(scope string, ops []json.RawMessage) (int, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback() //nolint:errcheck
	// deleted_at is stamped from the SERVER clock the moment a row becomes a TOMBSTONE, so
	// the GC can forget it by age (NULL otherwise). A newer tombstone only re-stamps it
	// later — retention can move out, never in (docs/tombstone-gc.html §05).
	//
	// Only presence rows (field='') and set-element removals (elem<>'') carry a meaningful
	// present flag. A field-VALUE row (field<>'' AND elem='') always has present=false on
	// the wire — that's NOT a tombstone, it's a live value, so it must keep deleted_at NULL
	// and never be purged. The `field='' OR elem<>''` guard encodes exactly that.
	stmt, err := tx.Prepare(`
INSERT INTO record_registers (scope,kind,entity,field,elem,optype,value,present,wall,ctr,node,seq,deleted_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, nextval('record_seq'),
        CASE WHEN (NOT $8) AND ($4 = '' OR $5 <> '') THEN now() END)
ON CONFLICT (scope,kind,entity,field,elem) DO UPDATE
  SET optype=EXCLUDED.optype, value=EXCLUDED.value, present=EXCLUDED.present,
      wall=EXCLUDED.wall, ctr=EXCLUDED.ctr, node=EXCLUDED.node, seq=EXCLUDED.seq,
      deleted_at = CASE WHEN (NOT EXCLUDED.present)
                         AND (EXCLUDED.field = '' OR EXCLUDED.elem <> '') THEN now() END
  WHERE (EXCLUDED.wall, EXCLUDED.ctr, EXCLUDED.node) >
        (record_registers.wall, record_registers.ctr, record_registers.node)`)
	if err != nil {
		return 0, err
	}
	defer stmt.Close()

	for _, raw := range ops {
		var op wireOp
		if err := json.Unmarshal(raw, &op); err != nil {
			continue // skip malformed
		}
		wall, ctr, node := splitHLC(op.HLC)
		if _, err := stmt.Exec(scope, op.Kind, op.ID, op.Field, op.Elem, op.Type, op.Value, op.Present, wall, ctr, node); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return s.maxSeq(scope), nil
}

func (s *pgRecordStore) maxSeq(scope string) int {
	var n sql.NullInt64
	_ = s.db.QueryRow(`SELECT max(seq) FROM record_registers WHERE scope=$1`, scope).Scan(&n)
	if n.Valid {
		return int(n.Int64)
	}
	return 0
}

// watermark is the highest seq the GC has ever reclaimed for this scope (0 if none).
// A client with cursor below it may have missed a purged delete → must full-reload.
func (s *pgRecordStore) watermark(scope string) int {
	var n sql.NullInt64
	_ = s.db.QueryRow(`SELECT watermark FROM record_gc WHERE scope=$1`, scope).Scan(&n)
	if n.Valid {
		return int(n.Int64)
	}
	return 0
}

// Pull returns every register whose seq > cursor, as ops the client applies via
// ApplyRemote (LWW). cursor 0 yields the full current copy of the workspace; a later
// cursor yields only the fields that changed since. newCursor is the max seq returned.
//
// Cursor-expiry (docs/tombstone-gc.html §03): if the client's cursor sits below the GC
// watermark, a delete it still needs may already have been purged — so its incremental
// view can't be trusted. We return expired=true and the client wipes + full-reloads
// (cursor 0), where deleted entities are simply absent.
func (s *pgRecordStore) Pull(scope string, cursor int) (ops []json.RawMessage, newCursor int, expired bool, err error) {
	w := s.watermark(scope)
	if cursor > 0 && cursor < w {
		return nil, cursor, true, nil
	}
	rows, err := s.db.Query(`
SELECT kind,entity,field,elem,optype,value,present,wall,ctr,node,seq
FROM record_registers WHERE scope=$1 AND seq > $2 ORDER BY seq`, scope, cursor)
	if err != nil {
		return nil, cursor, false, err
	}
	defer rows.Close()

	out := []json.RawMessage{}
	newCursor = cursor
	for rows.Next() {
		var kind, entity, field, elem, optype, value, node string
		var present bool
		var wall, ctr, seq int64
		if err := rows.Scan(&kind, &entity, &field, &elem, &optype, &value, &present, &wall, &ctr, &node, &seq); err != nil {
			return nil, cursor, false, err
		}
		op := wireOp{
			Type: optype, Kind: kind, ID: entity, Field: field, Elem: elem,
			Value: value, Present: present, HLC: fmt.Sprintf("%d.%d.%s", wall, ctr, node),
		}
		b, _ := json.Marshal(op)
		out = append(out, b)
		if int(seq) > newCursor {
			newCursor = int(seq)
		}
	}
	// Full-copy floor (docs/tombstone-gc.html §04, guardrail D8): a cursor-0 pull hands
	// back the whole current state, so the client is provably caught up. If the newest
	// LIVE rows sit below a purged tombstone's seq, newCursor would be < watermark and the
	// very next pull would loop-expire. Floor it at the watermark.
	if cursor == 0 && newCursor < w {
		newCursor = w
	}
	return out, newCursor, false, rows.Err()
}

// RunGC forgets tombstones older than `retention`, sweeps field/elem rows orphaned by a
// purged entity, and raises each affected tenant's watermark to the highest seq it
// reclaimed. Returns the number of rows reclaimed. Idempotent; safe to run on a timer.
// (docs/tombstone-gc.html §05.) The two DELETEs share one snapshot, so a field row whose
// presence is purged in THIS run is swept on the NEXT run — bounded by one extra interval.
func (s *pgRecordStore) RunGC(retention time.Duration) (int, error) {
	var n int
	err := s.db.QueryRow(`
WITH purged AS (
  DELETE FROM record_registers
   WHERE present = false AND deleted_at IS NOT NULL
     AND (field = '' OR elem <> '')  -- tombstones only, never field-value rows
     AND deleted_at < now() - make_interval(secs => $1)
  RETURNING scope, seq ),
swept AS (
  DELETE FROM record_registers r
   WHERE r.field <> ''
     AND NOT EXISTS (SELECT 1 FROM record_registers p
                      WHERE p.scope = r.scope AND p.kind = r.kind
                        AND p.entity = r.entity AND p.field = '')
  RETURNING scope, seq ),
reclaimed AS ( SELECT * FROM purged UNION ALL SELECT * FROM swept ),
bumped AS (
  INSERT INTO record_gc (scope, watermark)
  SELECT scope, max(seq) FROM reclaimed GROUP BY scope
  ON CONFLICT (scope) DO UPDATE SET watermark = GREATEST(record_gc.watermark, EXCLUDED.watermark)
  RETURNING scope )
SELECT count(*) FROM reclaimed`, retention.Seconds()).Scan(&n)
	return n, err
}
