package server

import (
	"testing"

	"things3-clone-desktop/core"
)

func op(id, node string, wall int64) core.Op {
	return core.Op{Type: "field", Kind: "task", ID: id, Field: "title", Value: []byte(`"x"`), Wall: wall, Ctr: 0, Node: node}
}

func TestAuthAndIsolation(t *testing.T) {
	h := NewHub("")

	// Register two users.
	tokA, idA, err := h.Register("alice", "pw1")
	if err != nil {
		t.Fatal(err)
	}
	tokB, idB, err := h.Register("bob", "pw2")
	if err != nil {
		t.Fatal(err)
	}
	if idA == idB {
		t.Fatal("user ids collided")
	}

	// Duplicate registration rejected.
	if _, _, err := h.Register("alice", "pw1"); err != ErrExists {
		t.Fatalf("want ErrExists, got %v", err)
	}
	// Wrong password rejected.
	if _, _, err := h.Login("alice", "nope"); err != ErrBadLogin {
		t.Fatalf("want ErrBadLogin, got %v", err)
	}
	// Bad token rejected.
	if _, err := h.Auth("garbage"); err != ErrNoAuth {
		t.Fatalf("want ErrNoAuth, got %v", err)
	}

	// Tokens resolve to their own user.
	if uid, _ := h.Auth(tokA); uid != idA {
		t.Fatal("tokA resolved wrong user")
	}
	if uid, _ := h.Auth(tokB); uid != idB {
		t.Fatal("tokB resolved wrong user")
	}

	// Alice pushes; Bob must NOT see it (isolation).
	_ = h.Push(idA, []core.Op{op("t1", "A", 1000)})
	aOps, aCur := h.Pull(idA, 0)
	if len(aOps) != 1 {
		t.Fatalf("alice should see her op, got %d", len(aOps))
	}
	bOps, _ := h.Pull(idB, 0)
	if len(bOps) != 0 {
		t.Fatalf("bob must not see alice's ops, got %d", len(bOps))
	}

	// Cursor advances: pulling again from the new cursor yields nothing.
	more, _ := h.Pull(idA, aCur)
	if len(more) != 0 {
		t.Fatalf("expected no new ops past cursor, got %d", len(more))
	}
}

// Two devices of the SAME user relay through the hub.
func TestRelayBetweenDevices(t *testing.T) {
	h := NewHub("")
	tok, uid, _ := h.Register("alice", "pw")
	_ = tok

	// Device 1 pushes two ops.
	_ = h.Push(uid, []core.Op{op("t1", "d1", 1000), op("t2", "d1", 1001)})

	// Device 2 (same user) pulls from zero → sees both.
	ops, cur := h.Pull(uid, 0)
	if len(ops) != 2 {
		t.Fatalf("device 2 should receive 2 ops, got %d", len(ops))
	}

	// Device 1 pushes another; device 2 pulls from its cursor → only the new one.
	_ = h.Push(uid, []core.Op{op("t3", "d1", 1002)})
	ops2, _ := h.Pull(uid, cur)
	if len(ops2) != 1 || ops2[0].ID != "t3" {
		t.Fatalf("incremental pull wrong: %+v", ops2)
	}
}

// The server rejects a batch containing an op stamped too far in the future,
// and stores none of it — so a device with a clock set ahead can't inject
// future-dated ops into the shared log.
func TestRejectFutureOps(t *testing.T) {
	h := NewHub("")
	h.now = func() int64 { return 1_000_000 }
	_, uid, _ := h.Register("alice", "pw")

	// In-window op is accepted.
	if err := h.Push(uid, []core.Op{op("t1", "n", 1_000_000)}); err != nil {
		t.Fatalf("in-window op should be accepted: %v", err)
	}
	before, _ := h.Pull(uid, 0)

	// A batch with a too-future op is rejected wholesale.
	err := h.Push(uid, []core.Op{
		op("t2", "n", 1_000_000),                  // fine
		op("t3", "n", 1_000_000+MaxClockSkewMs+1), // too far ahead
	})
	if err != ErrClockAhead {
		t.Fatalf("future op should be rejected with ErrClockAhead, got %v", err)
	}
	after, _ := h.Pull(uid, 0)
	if len(after) != len(before) {
		t.Fatalf("rejected batch must not be stored: before=%d after=%d", len(before), len(after))
	}
}

// A subscriber is nudged when the user's log grows.
func TestSubscribeNudge(t *testing.T) {
	h := NewHub("")
	_, uid, _ := h.Register("alice", "pw")
	sig, unsub := h.Subscribe(uid)
	defer unsub()

	_ = h.Push(uid, []core.Op{op("t1", "d1", 1000)})
	select {
	case n := <-sig:
		if n != 1 {
			t.Fatalf("nudge count = %d, want 1", n)
		}
	default:
		t.Fatal("expected a realtime nudge after push")
	}
}
