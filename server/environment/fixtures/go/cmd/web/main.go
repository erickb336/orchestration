// The Go fixture's tiny page (unit E2): the preview (go run ./cmd/web) serves it on PORT, on the container's loopback
// only, with go-cmp, the dependency the prepare phase downloaded from the Go module proxy.
package main

import (
	"fmt"
	"html"
	"log"
	"net/http"
	"os"

	"github.com/google/go-cmp/cmp"

	calc "example.com/envfixture"
)

func main() {
	diff := cmp.Diff([]int{2, 3}, []int{2, calc.Add(1, 2)})
	page := fmt.Sprintf(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Go fixture</title></head>
  <body style="font: 28px system-ui, sans-serif; padding: 48px; background: #eef7ef; color: #13241a">
    <h1>Go fixture</h1>
    <p>calc.Add(2, 3) = <strong>%d</strong>; go-cmp finds %s.</p>
  </body>
</html>`, calc.Add(2, 3), html.EscapeString(map[bool]string{true: "no difference", false: "a difference"}[diff == ""]))
	http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/html; charset=utf-8")
		fmt.Fprint(w, page)
	})
	addr := "127.0.0.1:" + os.Getenv("PORT")
	fmt.Println("serving on", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
