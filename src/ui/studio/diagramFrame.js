// The diagram frame's script (ORC-029 F2, diagrams.ts). It runs only inside the studio's sandboxed diagram frame: an
// opaque origin whose policy allows no request. A plain script, not a module, because a module needs CORS in an
// opaque origin. mermaid.min.js loads before it.
//
// It takes one message type from the page that made the frame, draws the diagram with Mermaid, and posts back the
// SVG text or the error. It reads nothing else and answers nothing else.
(function () {
  "use strict";
  var configured = "";
  function reply(message) {
    parent.postMessage(message, "*");
  }
  addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var d = event.data;
    if (!d || d.type !== "orc-diagram-draw" || typeof d.id !== "number" || typeof d.source !== "string" || typeof d.config !== "object") return;
    var failed = function (e) {
      reply({ type: "orc-diagram-failed", id: d.id, message: String((e && e.message) || e) });
    };
    try {
      var config = JSON.stringify(d.config);
      if (config !== configured) {
        window.mermaid.initialize(d.config);
        configured = config;
      }
      window.mermaid.render("orc-diagram-" + d.id, d.source).then(function (r) {
        reply({ type: "orc-diagram-drawn", id: d.id, svg: r.svg });
      }, failed);
    } catch (e) {
      failed(e);
    }
  });
  reply({ type: "orc-diagram-ready", mermaid: typeof window.mermaid === "object" });
})();
