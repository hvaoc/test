// Fractional string ranks for ordering (docs/architecture-1m.md §3).
//
// Position is a lexicographic string key, not a float. To move an item between two
// neighbours you compute a key strictly between their keys; unlike the float
// midpoint the current app uses, string keys subdivide INDEFINITELY, so a list can
// be reordered a million times in the same gap without ever exhausting precision or
// needing a global relabel. The key is a plain record field, so it syncs as an
// ordinary LWW delta.
//
// Keys are drawn from a base-62 digit alphabet whose bytewise order matches its
// alphabet order — the same order SQLite's default TEXT collation and Go string
// compare use. RankBetween(a, b) returns a key k with a < k < b bytewise. Empty a
// means "before b" (start); empty b means "after a" (end / +infinity).
package record

import "strings"

const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

func digitVal(b byte) int { return strings.IndexByte(digits, b) }

// RankBetween returns a key strictly between a and b under bytewise comparison.
// Callers pass a < b (or an empty bound); the result is stable and deterministic.
func RankBetween(a, b string) string {
	var sb strings.Builder
	for i := 0; ; i++ {
		// a's digit at i, or the lowest value (0) once a is exhausted.
		va := 0
		if i < len(a) {
			va = digitVal(a[i])
		}
		// b's digit at i. Empty/exhausted b is the supremum (one past the top).
		vb := len(digits)
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
		// Digits are adjacent (mid == va): keep a's digit and descend into the gap
		// above it, with the upper bound now open (+infinity) below this position.
		sb.WriteByte(digits[va])
		b = ""
	}
}

// RankAfter returns a key that sorts after last — appending to a list's end. Pass
// "" for an empty list.
func RankAfter(last string) string { return RankBetween(last, "") }
