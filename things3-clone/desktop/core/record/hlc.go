package record

import (
	"strconv"
	"strings"
)

// HLC is a Hybrid Logical Clock timestamp: physical ms + a logical counter + the
// node id, giving a total, deterministic, clock-skew-tolerant order. Wire-format
// "wall.ctr.node" matches core.HLC and the JS engine, so ops written on any
// platform compare equal on the others.
type HLC struct {
	Wall int64
	Ctr  int64
	Node string
}

func (h HLC) String() string {
	return strconv.FormatInt(h.Wall, 10) + "." + strconv.FormatInt(h.Ctr, 10) + "." + h.Node
}

func parseHLC(s string) HLC {
	parts := strings.SplitN(s, ".", 3)
	if len(parts) != 3 {
		return HLC{}
	}
	wall, _ := strconv.ParseInt(parts[0], 10, 64)
	ctr, _ := strconv.ParseInt(parts[1], 10, 64)
	return HLC{Wall: wall, Ctr: ctr, Node: parts[2]}
}

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

func (h HLC) After(o HLC) bool { return h.Compare(o) > 0 }

// maxDriftMs bounds how far a remote timestamp may push our clock ahead of real
// time, so a device with a wrong (future) clock can't drag everyone forward. Kept
// in sync with core/hlc.go and the server.
const maxDriftMs int64 = 5 * 60 * 1000

// clock issues monotonic local stamps and advances on witnessed remote stamps.
type clock struct {
	last HLC
	node string
	now  func() int64
}

func (c *clock) current() HLC { return c.last }

func (c *clock) local() HLC {
	wall := c.now()
	if wall > c.last.Wall {
		c.last = HLC{Wall: wall, Ctr: 0, Node: c.node}
	} else {
		c.last = HLC{Wall: c.last.Wall, Ctr: c.last.Ctr + 1, Node: c.node}
	}
	return c.last
}

func (c *clock) witness(r HLC) {
	wall := c.now()
	rWall := r.Wall
	if capw := wall + maxDriftMs; rWall > capw {
		rWall = capw
	}
	mx := c.last.Wall
	if rWall > mx {
		mx = rWall
	}
	if wall > mx {
		mx = wall
	}
	switch {
	case mx == c.last.Wall && mx == rWall:
		ctr := c.last.Ctr
		if r.Ctr > ctr {
			ctr = r.Ctr
		}
		c.last = HLC{Wall: mx, Ctr: ctr + 1, Node: c.node}
	case mx == c.last.Wall:
		c.last = HLC{Wall: mx, Ctr: c.last.Ctr + 1, Node: c.node}
	case mx == rWall:
		c.last = HLC{Wall: mx, Ctr: r.Ctr + 1, Node: c.node}
	default:
		c.last = HLC{Wall: mx, Ctr: 0, Node: c.node}
	}
}

// Op is one CRDT operation (wire format shared with the server + JS engine).
type Op struct {
	Type    string `json:"t"` // "field" | "set" | "presence"
	Kind    string `json:"k"`
	ID      string `json:"i"`
	Field   string `json:"f,omitempty"`
	Elem    string `json:"e,omitempty"`
	Value   string `json:"v,omitempty"` // canonical JSON of the value
	Present bool   `json:"p,omitempty"`
	HLC     HLC    `json:"h"`
}

// Node returns the op's originating node (its HLC tie-break id).
func (o Op) Node() string { return o.HLC.Node }
