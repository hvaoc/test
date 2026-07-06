// Fractional ordering keys (docs/architecture-1m.md §3).
//
// Position is a lexicographic string key, not a float, so it subdivides
// indefinitely and never needs a global relabel. Two operations:
//
//   - APPEND (the hot path: adding to a list end) uses a fixed-width base-62
//     counter, Pad62. Monotonic and constant-length, so N sequential appends cost
//     O(N) storage total, not O(N²). (A midpoint-toward-infinity would converge on
//     the top digit and then grow the key ~1 char every few appends — O(N²); the
//     load test caught exactly that.)
//   - INSERT / REORDER between two existing neighbours uses RankBetween, the
//     midpoint of the two keys. Bounded, and the key stays a plain LWW field.
//
// Both draw from a base-62 alphabet whose bytewise order matches its alphabet
// order — the order SQLite's default TEXT collation and Go string compare use.
package record

import "strings"

const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// rankWidth is the fixed width of an append key. 62^11 ≈ 5.2e19 > math.MaxUint64,
// so every uint64 counter value fits without truncation, and all append keys sort
// correctly against each other by plain bytewise comparison.
const rankWidth = 11

func digitVal(b byte) int { return strings.IndexByte(digits, b) }

// Pad62 renders n as a fixed-width, zero-left-padded base-62 string. Larger n →
// lexicographically greater key, so an incrementing counter yields append order.
func Pad62(n uint64) string {
	buf := make([]byte, rankWidth)
	for i := rankWidth - 1; i >= 0; i-- {
		buf[i] = digits[n%62]
		n /= 62
	}
	return string(buf)
}

// RankBetween returns a key strictly between a and b under bytewise comparison.
// Callers pass a < b (an empty bound means start/end). Used for inserts and
// reorders between two existing neighbours.
func RankBetween(a, b string) string {
	var sb strings.Builder
	for i := 0; ; i++ {
		va := 0
		if i < len(a) {
			va = digitVal(a[i])
		}
		vb := len(digits) // empty/exhausted b is the supremum (one past the top)
		if b != "" && i < len(b) {
			vb = digitVal(b[i])
		}
		if va == vb {
			sb.WriteByte(digits[va]) // shared prefix — copy and descend
			continue
		}
		mid := (va + vb) / 2
		if mid > va {
			sb.WriteByte(digits[mid]) // room between the digits — done
			return sb.String()
		}
		// Adjacent digits: keep a's digit and descend into the gap above it, with
		// the upper bound now open (+infinity) below this position.
		sb.WriteByte(digits[va])
		b = ""
	}
}
