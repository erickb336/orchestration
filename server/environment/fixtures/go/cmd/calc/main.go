// The Go fixture's CLI (unit E2), built in the recording itself (go build) with go-cmp from the prepare phase.
package main

import (
	"fmt"
	"os"
	"strconv"

	"github.com/google/go-cmp/cmp"

	calc "example.com/envfixture"
)

func main() {
	a, _ := strconv.Atoi(os.Args[1])
	b, _ := strconv.Atoi(os.Args[2])
	sum := calc.Add(a, b)
	fmt.Printf("%d + %d = %d (go-cmp says equal to %d: %v)\n", a, b, sum, a+b, cmp.Equal(sum, a+b))
}
