package auth

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"things3-clone-desktop/core/ydoc"
	"things3-clone-desktop/server/ysync"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	acc, err := Open("")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	acc.Mount(mux)
	ysync.NewHub(acc, ysync.NewMemPersistence()).Mount(mux)
	return httptest.NewServer(ysync.CORS(mux))
}

func call(t *testing.T, method, url, token string, body any) (int, map[string]any) {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, url, rdr)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

func firstTenant(m map[string]any) (id, role string) {
	ts, _ := m["tenants"].([]any)
	if len(ts) == 0 {
		return "", ""
	}
	t0 := ts[0].(map[string]any)
	return t0["id"].(string), t0["role"].(string)
}

// --- ydoc update helpers -----------------------------------------------------

func snap(tasks ...map[string]any) string {
	b, _ := json.Marshal(map[string]any{
		"areas": []any{}, "projects": []any{}, "headings": []any{},
		"tasks": tasks, "customViews": []any{}, "tags": []any{}, "settings": map[string]any{},
	})
	return string(b)
}
func updateWithTask(id, title, notes string) string {
	e := ydoc.New()
	_ = e.ApplyLocalSnapshot(snap(map[string]any{"id": id, "title": title, "notes": notes, "checklist": []any{}, "tags": []any{}}))
	return base64.StdEncoding.EncodeToString(e.EncodeAll())
}
func tasksFromUpdateB64(t *testing.T, b64 string) map[string]map[string]any {
	t.Helper()
	upd, _ := base64.StdEncoding.DecodeString(b64)
	e, err := ydoc.Load(1, upd)
	if err != nil {
		t.Fatal(err)
	}
	js, _ := e.Materialize()
	var out struct {
		Tasks []map[string]any `json:"tasks"`
	}
	_ = json.Unmarshal([]byte(js), &out)
	m := map[string]map[string]any{}
	for _, tk := range out.Tasks {
		m[tk["id"].(string)] = tk
	}
	return m
}

// --- tests -------------------------------------------------------------------

func TestRegisterLogin(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	code, m := call(t, "POST", srv.URL+"/v1/register", "", map[string]string{"username": "alice", "password": "hunter2"})
	if code != 200 {
		t.Fatalf("register: %d %v", code, m)
	}
	if m["token"] == "" || m["userId"] == "" {
		t.Fatalf("register missing token/userId: %v", m)
	}
	if _, role := firstTenant(m); role != ysync.RoleOwner {
		t.Fatalf("new user should own a personal tenant, got role %q", role)
	}

	// Duplicate username -> 409.
	if code, _ := call(t, "POST", srv.URL+"/v1/register", "", map[string]string{"username": "alice", "password": "hunter2"}); code != 409 {
		t.Fatalf("duplicate register should 409, got %d", code)
	}
	// Wrong password -> 401.
	if code, _ := call(t, "POST", srv.URL+"/v1/login", "", map[string]string{"username": "alice", "password": "nope"}); code != 401 {
		t.Fatalf("bad login should 401, got %d", code)
	}
	// Correct login -> token.
	if code, m := call(t, "POST", srv.URL+"/v1/login", "", map[string]string{"username": "alice", "password": "hunter2"}); code != 200 || m["token"] == "" {
		t.Fatalf("login should succeed: %d %v", code, m)
	}
}

// Full team flow with roles: an owner writes, a viewer can read but not write,
// enforced through the real server end to end.
func TestTeamRolesEndToEnd(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	_, reg := call(t, "POST", srv.URL+"/v1/register", "", map[string]string{"username": "owner", "password": "ownerpw"})
	ownerSess := reg["token"].(string)
	tenantID, _ := firstTenant(reg)

	_, reg2 := call(t, "POST", srv.URL+"/v1/register", "", map[string]string{"username": "reader", "password": "readerpw"})
	readerSess := reg2["token"].(string)

	// Owner adds reader to the tenant as a VIEWER.
	if code, m := call(t, "POST", srv.URL+"/v1/members", ownerSess, map[string]string{"tenantId": tenantID, "username": "reader", "role": ysync.RoleViewer}); code != 200 {
		t.Fatalf("add member: %d %v", code, m)
	}

	// Each mints a tenant-scoped sync token.
	_, ot := call(t, "POST", srv.URL+"/v1/synctoken", ownerSess, map[string]string{"tenantId": tenantID})
	ownerSync := ot["token"].(string)
	if ot["role"] != ysync.RoleOwner {
		t.Fatalf("owner sync role: %v", ot)
	}
	_, rt := call(t, "POST", srv.URL+"/v1/synctoken", readerSess, map[string]string{"tenantId": tenantID})
	readerSync := rt["token"].(string)
	if rt["role"] != ysync.RoleViewer {
		t.Fatalf("reader sync role: %v", rt)
	}

	// Owner pushes a task.
	if code, _ := call(t, "POST", srv.URL+"/v1/push", ownerSync, map[string]string{"update": updateWithTask("t1", "Roadmap", "secret")}); code != 200 {
		t.Fatalf("owner push should succeed, got %d", code)
	}

	// Viewer can PULL and see it.
	code, pull := call(t, "POST", srv.URL+"/v1/pull", readerSync, map[string]string{})
	if code != 200 {
		t.Fatalf("viewer pull: %d", code)
	}
	if tasksFromUpdateB64(t, pull["update"].(string))["t1"]["title"] != "Roadmap" {
		t.Fatalf("viewer didn't receive the task: %v", pull)
	}

	// Viewer CANNOT push -> 403.
	if code, m := call(t, "POST", srv.URL+"/v1/push", readerSync, map[string]string{"update": updateWithTask("t2", "sneaky", "")}); code != 403 {
		t.Fatalf("viewer push must be 403, got %d %v", code, m)
	}
}

// A user's tenant token can't reach another user's private tenant.
func TestTenantIsolationReal(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	_, a := call(t, "POST", srv.URL+"/v1/register", "", map[string]string{"username": "amy", "password": "amypass"})
	aSess := a["token"].(string)
	aTenant, _ := firstTenant(a)
	_, aSync := call(t, "POST", srv.URL+"/v1/synctoken", aSess, map[string]string{"tenantId": aTenant})
	call(t, "POST", srv.URL+"/v1/push", aSync["token"].(string), map[string]string{"update": updateWithTask("secret", "Amy plan", "")})

	_, b := call(t, "POST", srv.URL+"/v1/register", "", map[string]string{"username": "bob", "password": "bobpass"})
	bSess := b["token"].(string)
	bTenant, _ := firstTenant(b)
	_, bSync := call(t, "POST", srv.URL+"/v1/synctoken", bSess, map[string]string{"tenantId": bTenant})

	_, pull := call(t, "POST", srv.URL+"/v1/pull", bSync["token"].(string), map[string]string{})
	if got := tasksFromUpdateB64(t, pull["update"].(string)); len(got) != 0 {
		t.Fatalf("cross-tenant leak: bob saw %v", got)
	}
}

// Two different accounts that enter the SAME workspace code land in one shared
// tenant and can collaborate; a task one pushes, the other pulls.
func TestSharedWorkspaceCollaboration(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	// Alice creates the workspace "acme-team"; Bob joins it by the same code.
	_, aReg := call(t, "POST", srv.URL+"/v1/register", "", map[string]string{"username": "alice", "password": "alicepw"})
	aSess := aReg["token"].(string)
	_, aJoin := call(t, "POST", srv.URL+"/v1/join", aSess, map[string]string{"code": "acme-team"})
	aTenant := aJoin["tenant"].(map[string]any)

	_, bReg := call(t, "POST", srv.URL+"/v1/register", "", map[string]string{"username": "bob", "password": "bobpw12"})
	bSess := bReg["token"].(string)
	_, bJoin := call(t, "POST", srv.URL+"/v1/join", bSess, map[string]string{"code": "acme-team"})
	bTenant := bJoin["tenant"].(map[string]any)

	if aTenant["id"] != bTenant["id"] {
		t.Fatalf("same workspace code must map to one tenant: alice=%v bob=%v", aTenant["id"], bTenant["id"])
	}
	if aTenant["role"] != ysync.RoleOwner || bTenant["role"] != ysync.RoleEditor {
		t.Fatalf("creator should own, joiner should edit: alice=%v bob=%v", aTenant["role"], bTenant["role"])
	}

	// Each mints a sync token for the shared workspace, then Alice pushes a task
	// and Bob pulls it.
	_, aTok := call(t, "POST", srv.URL+"/v1/synctoken", aSess, map[string]string{"tenantId": aTenant["id"].(string)})
	_, bTok := call(t, "POST", srv.URL+"/v1/synctoken", bSess, map[string]string{"tenantId": bTenant["id"].(string)})

	call(t, "POST", srv.URL+"/v1/push", aTok["token"].(string), map[string]string{"update": updateWithTask("t1", "Shared task", "hello team")})
	_, pull := call(t, "POST", srv.URL+"/v1/pull", bTok["token"].(string), map[string]string{})
	got := tasksFromUpdateB64(t, pull["update"].(string))
	if got["t1"]["title"] != "Shared task" {
		t.Fatalf("bob didn't get alice's task in the shared workspace: %v", got)
	}
}

// Minting a sync token for a tenant you don't belong to is forbidden.
func TestSyncTokenRequiresMembership(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()
	_, a := call(t, "POST", srv.URL+"/v1/register", "", map[string]string{"username": "u1", "password": "pass12"})
	_, b := call(t, "POST", srv.URL+"/v1/register", "", map[string]string{"username": "u2", "password": "pass12"})
	bTenant, _ := firstTenant(b)
	// u1 tries to mint a token for u2's private tenant.
	if code, _ := call(t, "POST", srv.URL+"/v1/synctoken", a["token"].(string), map[string]string{"tenantId": bTenant}); code != 403 {
		t.Fatalf("minting for a non-member tenant must be 403, got %d", code)
	}
}
