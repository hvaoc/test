package ysync

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

// postJSON POSTs body with a bearer token and decodes the JSON response.
func postJSON(url, token string, body []byte) (map[string]any, error) {
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// rawPost returns the raw body string and status code (no token).
func rawPost(t *testing.T, url, token, body string) (string, int) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("rawPost: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return string(b), resp.StatusCode
}
