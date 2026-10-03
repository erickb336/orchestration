package calc

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

// go-cmp comes from the Go module proxy in the prepare phase; the test runs with no network.
func TestAdd(t *testing.T) {
	if d := cmp.Diff(4, Add(2, 2)); d != "" {
		t.Fatal(d)
	}
}
