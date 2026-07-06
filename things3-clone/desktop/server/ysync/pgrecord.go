package ysync

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
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
CREATE SEQUENCE IF NOT EXISTS record_seq;`
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
	stmt, err := tx.Prepare(`
INSERT INTO record_registers (scope,kind,entity,field,elem,optype,value,present,wall,ctr,node,seq)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, nextval('record_seq'))
ON CONFLICT (scope,kind,entity,field,elem) DO UPDATE
  SET optype=EXCLUDED.optype, value=EXCLUDED.value, present=EXCLUDED.present,
      wall=EXCLUDED.wall, ctr=EXCLUDED.ctr, node=EXCLUDED.node, seq=EXCLUDED.seq
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

// Pull returns every register whose seq > cursor, as ops the client applies via
// ApplyRemote (LWW). cursor 0 yields the full current copy of the workspace; a later
// cursor yields only the fields that changed since. newCursor is the max seq returned.
func (s *pgRecordStore) Pull(scope string, cursor int) ([]json.RawMessage, int, error) {
	rows, err := s.db.Query(`
SELECT kind,entity,field,elem,optype,value,present,wall,ctr,node,seq
FROM record_registers WHERE scope=$1 AND seq > $2 ORDER BY seq`, scope, cursor)
	if err != nil {
		return nil, cursor, err
	}
	defer rows.Close()

	out := []json.RawMessage{}
	newCursor := cursor
	for rows.Next() {
		var kind, entity, field, elem, optype, value, node string
		var present bool
		var wall, ctr, seq int64
		if err := rows.Scan(&kind, &entity, &field, &elem, &optype, &value, &present, &wall, &ctr, &node, &seq); err != nil {
			return nil, cursor, err
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
	return out, newCursor, rows.Err()
}
