package core

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
)

// HLC is a Hybrid Logical Clock timestamp: physical wall-clock milliseconds
// combined with a logical counter and the originating node id. HLCs give every
// mutation a total, deterministic order that (a) tracks causality — a value read
// then written gets a strictly greater stamp — and (b) tolerates clock skew
// between devices, unlike raw wall-clock time. The node id breaks ties so two
// replicas ALWAYS pick the same winner for concurrent writes, which is what
// makes conflict resolution automatic and convergent.
type HLC struct {
	Wall int64  `json:"w"` // physical time (ms since epoch)
	Ctr  int64  `json:"c"` // logical counter for events within the same ms
	Node string `json:"n"` // originating device id (deterministic tie-break)
}

// Compare orders by (Wall, Ctr, Node). Returns -1, 0, or 1.
func (h HLC) Compare(o HLC) int {
	switch {
	case h.Wall != o.Wall:
		if h.Wall < o.Wall {
			return -1
		}
		return 1
	case h.Ctr != o.Ctr:
		if h.Ctr < o.Ctr {
			return -1
		}
		return 1
	case h.Node != o.Node:
		if h.Node < o.Node {
			return -1
		}
		return 1
	default:
		return 0
	}
}

// After reports whether h is strictly greater than o (h wins under LWW).
func (h HLC) After(o HLC) bool { return h.Compare(o) > 0 }

func (h HLC) String() string { return fmt.Sprintf("%d.%d.%s", h.Wall, h.Ctr, h.Node) }

func parseHLC(s string) HLC {
	if s == "" {
		return HLC{}
	}
	p := strings.SplitN(s, ".", 3)
	if len(p) != 3 {
		return HLC{}
	}
	w, _ := strconv.ParseInt(p[0], 10, 64)
	c, _ := strconv.ParseInt(p[1], 10, 64)
	return HLC{Wall: w, Ctr: c, Node: p[2]}
}

// clock is a node's monotonic HLC generator. It is safe for concurrent use.
type clock struct {
	mu   sync.Mutex
	last HLC
	node string
	now  func() int64 // physical clock (ms); injectable for tests
}

func newClock(node string, now func() int64, last HLC) *clock {
	return &clock{node: node, now: now, last: last}
}

// local stamps a locally-originated event. Standard HLC send rule: advance to
// max(last.Wall, physicalNow); bump the counter when the wall time didn't move.
func (c *clock) local() HLC {
	c.mu.Lock()
	defer c.mu.Unlock()
	wall := c.now()
	if wall > c.last.Wall {
		c.last = HLC{Wall: wall, Ctr: 0, Node: c.node}
	} else {
		c.last = HLC{Wall: c.last.Wall, Ctr: c.last.Ctr + 1, Node: c.node}
	}
	return c.last
}

// witness advances the local clock past a remote timestamp we just received, so
// any subsequent local event is causally ordered after it (HLC receive rule).
func (c *clock) witness(remote HLC) {
	c.mu.Lock()
	defer c.mu.Unlock()
	wall := c.now()
	max := c.last.Wall
	if remote.Wall > max {
		max = remote.Wall
	}
	if wall > max {
		max = wall
	}
	switch {
	case max == c.last.Wall && max == remote.Wall:
		if c.last.Ctr > remote.Ctr {
			c.last = HLC{Wall: max, Ctr: c.last.Ctr + 1, Node: c.node}
		} else {
			c.last = HLC{Wall: max, Ctr: remote.Ctr + 1, Node: c.node}
		}
	case max == c.last.Wall:
		c.last = HLC{Wall: max, Ctr: c.last.Ctr + 1, Node: c.node}
	case max == remote.Wall:
		c.last = HLC{Wall: max, Ctr: remote.Ctr + 1, Node: c.node}
	default:
		c.last = HLC{Wall: max, Ctr: 0, Node: c.node}
	}
}

func (c *clock) current() HLC {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.last
}
