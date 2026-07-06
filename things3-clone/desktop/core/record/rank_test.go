package record

import "testing"

// TestPad62Compact guards the O(N²) regression the load test caught: append keys
// must stay constant-width and strictly increasing over a million appends.
func TestPad62Compact(t *testing.T) {
	prev := ""
	for i := uint64(1); i <= 1000000; i++ {
		k := Pad62(i)
		if len(k) != rankWidth {
			t.Fatalf("append %d width %d, want %d", i, len(k), rankWidth)
		}
		if k <= prev {
			t.Fatalf("append %d not increasing: %q !> %q", i, k, prev)
		}
		prev = k
	}
}

// TestRankBetweenOrders checks the midpoint invariant a < RankBetween(a,b) < b across
// appends and repeated subdivision of the same gap.
func TestRankBetweenOrders(t *testing.T) {
	cases := [][2]string{{"", ""}, {"V", "W"}, {"V", ""}, {"", "V"}, {"AA", "AB"}}
	for _, c := range cases {
		a, b := c[0], c[1]
		m := RankBetween(a, b)
		if a != "" && !(m > a) {
			t.Fatalf("RankBetween(%q,%q)=%q not > a", a, b, m)
		}
		if b != "" && !(m < b) {
			t.Fatalf("RankBetween(%q,%q)=%q not < b", a, b, m)
		}
	}
	// repeatedly subdivide the low side of a gap; keys stay ordered and unique
	lo, hi := "a", "b"
	seen := map[string]bool{lo: true, hi: true}
	for i := 0; i < 2000; i++ {
		m := RankBetween(lo, hi)
		if !(m > lo && m < hi) {
			t.Fatalf("subdivide %d: %q not in (%q,%q)", i, m, lo, hi)
		}
		if seen[m] {
			t.Fatalf("subdivide %d: duplicate key %q", i, m)
		}
		seen[m] = true
		hi = m // shrink toward lo
	}
}
