package crdt

// HLC is a Hybrid Logical Clock timestamp (see desktop/core/hlc.go for the full
// rationale): physical ms + a logical counter + the node id, giving a total,
// deterministic, clock-skew-tolerant order. Wire-compatible with core.HLC.
type HLC struct {
	Wall int64  `json:"w"`
	Ctr  int64  `json:"c"`
	Node string `json:"n"`
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
