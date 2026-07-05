package ysync

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func dialWS(t *testing.T, srv *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/stream?token=" + token
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", u, err)
	}
	return c
}

// readFrame reads one JSON frame with a timeout.
func readFrame(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, b, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}

// Two teammates on the realtime channel exchange presence, and a disconnect is
// announced.
func TestAwarenessRelay(t *testing.T) {
	srv := httptest.NewServer(NewHub(DevAuth{}, NewMemPersistence()).Handler())
	defer srv.Close()

	alice := dialWS(t, srv, "acme:alice")
	defer alice.Close()
	bob := dialWS(t, srv, "acme:bob")
	defer bob.Close()

	// Alice broadcasts her presence (name + cursor). Bob should receive it.
	state := json.RawMessage(`{"user":"alice","color":"#f00","taskId":"t1","cursor":5}`)
	if err := alice.WriteJSON(map[string]any{"type": "presence", "state": state}); err != nil {
		t.Fatal(err)
	}

	frame := readFrame(t, bob)
	if frame["type"] != "presence" {
		t.Fatalf("bob expected presence, got %v", frame)
	}
	st, _ := frame["state"].(map[string]any)
	if st["user"] != "alice" || st["taskId"] != "t1" {
		t.Fatalf("bob got wrong presence state: %v", frame)
	}

	// When Alice disconnects, Bob is told her presence is gone.
	alice.Close()
	frame = readFrame(t, bob)
	if frame["type"] != "presence-leave" {
		t.Fatalf("bob expected presence-leave after alice left, got %v", frame)
	}
}

// A viewer (read-only) still receives peers' presence but its own presence is not
// relayed (it can observe collaborators without being able to write).
func TestAwarenessViewerReceivesButCannotBroadcast(t *testing.T) {
	// Custom auth: "viewer" token -> viewer role, anything else -> editor.
	srv := httptest.NewServer(NewHub(roleAuth{}, NewMemPersistence()).Handler())
	defer srv.Close()

	editor := dialWS(t, srv, "editor")
	defer editor.Close()
	viewer := dialWS(t, srv, "viewer")
	defer viewer.Close()

	// Editor broadcasts -> viewer receives.
	_ = editor.WriteJSON(map[string]any{"type": "presence", "state": json.RawMessage(`{"user":"ed"}`)})
	if f := readFrame(t, viewer); f["type"] != "presence" {
		t.Fatalf("viewer should receive editor presence, got %v", f)
	}

	// Viewer tries to broadcast -> editor must NOT receive it (we assert a timeout).
	_ = viewer.WriteJSON(map[string]any{"type": "presence", "state": json.RawMessage(`{"user":"vi"}`)})
	_ = editor.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
	if _, _, err := editor.ReadMessage(); err == nil {
		t.Fatal("editor received a frame from a read-only viewer's presence (should be suppressed)")
	}
}

// roleAuth: token "viewer" -> viewer, else editor; all in one shared tenant.
type roleAuth struct{}

func (roleAuth) Resolve(token string) (Principal, error) {
	role := RoleEditor
	if token == "viewer" {
		role = RoleViewer
	}
	return Principal{UserID: token, TenantID: "team", Role: role}, nil
}

var _ Authenticator = roleAuth{}
var _ = http.StatusOK
