package core

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// HTTPAdapter is a real SyncAdapter that talks to the sync server (see
// ../server) over HTTP — the production replacement for MockAdapter. Point the
// desktop/mobile store at it with store.SetAdapter(core.NewHTTPAdapter(url,
// token)) and the exact same push/pull/merge flow now syncs across the network.
type HTTPAdapter struct {
	base   string
	token  string
	client *http.Client
}

func NewHTTPAdapter(baseURL, token string) *HTTPAdapter {
	return &HTTPAdapter{
		base:   strings.TrimRight(baseURL, "/"),
		token:  token,
		client: &http.Client{Timeout: 30 * time.Second},
	}
}

func (a *HTTPAdapter) Name() string { return "server" }

func (a *HTTPAdapter) Push(ops []Op) error {
	body, err := json.Marshal(map[string]interface{}{"ops": ops})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, a.base+"/v1/push", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.token)
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("push: server returned %d", resp.StatusCode)
	}
	return nil
}

func (a *HTTPAdapter) Pull(sinceCursor string) ([]Op, string, error) {
	u := a.base + "/v1/pull?cursor=" + url.QueryEscape(sinceCursor)
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, sinceCursor, err
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, sinceCursor, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, sinceCursor, fmt.Errorf("pull: server returned %d", resp.StatusCode)
	}
	var out struct {
		Ops    []Op   `json:"ops"`
		Cursor string `json:"cursor"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, sinceCursor, err
	}
	return out.Ops, out.Cursor, nil
}
