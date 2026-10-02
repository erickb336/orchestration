// The studio's frames (ORC-029 pass 3d): a prototype in a desktop or phone frame, scaled to fit, with the owner's
// pins over it; a terminal window for terminal demos and TUIs; and the plain words shown when nothing can be.
//
// A prototype is code an agent wrote. It is framed with sandbox="allow-scripts" and never allow-same-origin, from
// its own origin on the prototype port (runtime/prototype.ts); the service adds the rest of the guard
// (server/studio/serve.ts). Pins come from the service's pin script in the frame and are taken only in Pin mode,
// only from that frame's window (pinFromMessage).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { StudioArtifact } from "../../domain/studio/types";
import type { PinMessage } from "../../runtime/prototype";
import { EmptyState } from "../kit";
import { frameSize, readCast, renderAnsi, type TermLine } from "./ansi";
import { DEVICE_SIZE, pinFromMessage, serviceFileUrl, shotPath, type DraftPin, type ScreenDevice } from "./studioView";

/** The width of an element, followed as it changes; null until measured (and when rendered on the server). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Content of a fixed size (a 1280×800 page), scaled down to the width it has, never up. */
export function ScaledBox({ width, height, label, children }: { width: number; height: number; label: string; children: ReactNode }) {
  const [ref, avail] = useWidth<HTMLDivElement>();
  const scale = avail ? Math.min(1, avail / width) : 0.5;
  return (
    <div ref={ref} className="st-fit" role="group" aria-label={label}>
      <div className="st-fit__box" style={{ width: width * scale, height: height * scale }}>
        <div className="st-fit__inner" style={{ width, height, transform: `scale(${scale})` }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** The owner's pins over a frame: numbered markers at their place (fractions of the page). The list under the stage is their accessible form. */
function PinMarkers({ pins }: { pins: { pin: DraftPin; n: number }[] }) {
  return (
    <div className="st-pins" aria-hidden="true">
      {pins.map(({ pin, n }) => (
        <span key={n} className="st-pin" style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}>
          <span>{n}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * One variant of a prototype in a device frame: desktop 1280×800 in a browser window, mobile 390×844 in a phone,
 * scaled to fit. While Pin mode is on, a click in the prototype becomes a pin (`onPin`).
 */
export function DeviceFrame({ src, title, device, pins, pinMode, onPin }: { src: string; title: string; device: ScreenDevice; pins: { pin: DraftPin; n: number }[]; pinMode: boolean; onPin: (pin: PinMessage) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // The listener stays for the frame's life and reads Pin mode as of the last commit, which a click on Pin a comment
  // reaches before any later click in the prototype can (a layout effect runs before the browser's next event).
  const latest = useRef({ pinMode, onPin });
  useLayoutEffect(() => {
    latest.current = { pinMode, onPin };
  });
  useEffect(() => {
    const on = (e: MessageEvent) => {
      const pin = pinFromMessage(latest.current.pinMode, e, frame.current?.contentWindow);
      if (pin) latest.current.onPin(pin);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  const size = DEVICE_SIZE[device];
  const viewport = (
    <div className="st-viewport">
      <iframe key={src} ref={frame} src={src} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" className="st-viewport__frame" />
      <PinMarkers pins={pins} />
    </div>
  );
  if (device === "mobile") {
    return (
      <ScaledBox width={size.width + 24} height={size.height + 24} label={`${title}, in a phone frame`}>
        <div className="st-phone">{viewport}</div>
      </ScaledBox>
    );
  }
  return (
    <ScaledBox width={size.width} height={size.height + 32} label={`${title}, in a browser window`}>
      <div className="st-browser">
        <div className="st-browser__bar" aria-hidden="true">
          <i />
          <i />
          <i />
          <span className="st-browser__url">{new URL(src).pathname}</span>
        </div>
        {viewport}
      </div>
    </ScaledBox>
  );
}

/** A file shown as it is, in a plain sandboxed frame (a contract, a flow map, what the owner brought). */
export function PlainFrame({ src, title }: { src: string; title: string }) {
  return (
    <div className="st-plain">
      <iframe key={src} src={src} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" className="st-plain__frame" />
    </div>
  );
}

const NO_PROTOTYPE_SERVER = "The prototype server is not running, so the live prototype cannot be shown. Restarting the service starts it; if its port is taken, set ORCHESTRATION_PROTOTYPE_PORT.";

/** Without the prototype server: the variant's screenshot on this device when the service has one, else why nothing is shown. */
export function ScreenshotFallback({ artifact, variant, device }: { artifact: StudioArtifact; variant: string | undefined; device: ScreenDevice }) {
  const [failed, setFailed] = useState(false);
  if (variant === undefined || failed) {
    return (
      <EmptyState title="Nothing to show">
        {NO_PROTOTYPE_SERVER} {variant === undefined ? "" : "There is no screenshot of this variant on this device either."}
      </EmptyState>
    );
  }
  return (
    <div className="st-shot">
      <p className="small muted">{NO_PROTOTYPE_SERVER} This is its screenshot.</p>
      <img src={serviceFileUrl(artifact, shotPath(variant, device))} alt={`Screenshot of ${artifact.title}, ${device}`} onError={() => setFailed(true)} />
    </div>
  );
}

/** Nothing can be framed without the prototype server; said plainly. */
export function NoPrototypeServer() {
  return <EmptyState title="Nothing to show">{NO_PROTOTYPE_SERVER}</EmptyState>;
}

/** A terminal window: three dots, a title, and the screen. Always a window (the owner's mark on pass 1). */
export function TerminalWindow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <figure className="st-term">
      <figcaption className="st-term__bar">
        <i aria-hidden="true" />
        <i aria-hidden="true" />
        <i aria-hidden="true" />
        <span>{title}</span>
      </figcaption>
      <div className="st-term__screen">{children}</div>
    </figure>
  );
}

/** Lines of terminal text at a terminal size: `cols` characters wide and at least `rows` lines tall. Text only. */
export function TerminalText({ lines, cols, rows, label }: { lines: TermLine[]; cols: number; rows: number; label: string }) {
  return (
    <pre className="st-term__text" style={{ width: `${cols}ch`, minHeight: `${rows * 1.45}em` }} aria-label={label}>
      {lines.map((line, i) => (
        <span key={i} className="st-term__line">
          {line.map((run, j) =>
            run.cls ? (
              <span key={j} className={run.cls}>
                {run.text}
              </span>
            ) : (
              run.text
            ),
          )}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

type Loaded = { status: "loading" } | { status: "ok"; text: string } | { status: "error"; message: string };

/** A version's text file, read through the app's own service (the prototype origin cannot be read from here). */
function useServiceText(url: string): Loaded {
  const [loaded, setLoaded] = useState<{ url: string; value: Loaded }>({ url, value: { status: "loading" } });
  useEffect(() => {
    let live = true;
    const done = (value: Loaded) => live && setLoaded({ url, value });
    fetch(url, { headers: { Accept: "text/plain" }, cache: "no-store" })
      .then(async (res) => (res.ok ? done({ status: "ok", text: await res.text() }) : done({ status: "error", message: res.status === 404 ? "the service has no such file for the app (404)" : `the service answered ${res.status}` })))
      .catch(() => done({ status: "error", message: "the service is unreachable" }));
    return () => {
      live = false;
    };
  }, [url]);
  return loaded.url === url ? loaded.value : { status: "loading" };
}

/**
 * A hand-written terminal file drawn in a window: a `.ans` frame at the smallest studio size it fits, or a `.cast`
 * file's text transcript, labelled as a hand-written recording (the asciinema player is not part of this pass).
 */
export function TerminalFile({ artifact, path, kind }: { artifact: StudioArtifact; path: string; kind: "frame" | "cast" | "transcript" }) {
  const loaded = useServiceText(serviceFileUrl(artifact, path));
  if (loaded.status === "loading") return <p className="small muted">Reading {path}…</p>;
  if (loaded.status === "error") {
    return (
      <p className="small muted">
        {path} cannot be drawn: {loaded.message}.
      </p>
    );
  }
  if (kind === "cast") {
    const cast = readCast(loaded.text);
    if (!cast.ok) {
      return (
        <p className="small muted">
          {path} cannot be read: {cast.error}.
        </p>
      );
    }
    return (
      <div className="st-stack">
        <TerminalWindow title={`${cast.title ?? artifact.title} — ${cast.cols}×${cast.rows} — hand-written recording`}>
          <TerminalText lines={renderAnsi(cast.output, cast)} cols={cast.cols} rows={cast.rows} label={`Transcript of ${path}`} />
        </TerminalWindow>
        <p className="small muted">A hand-written recording: its text transcript, not a recording of a real terminal.{cast.markers.length ? ` Chapters: ${cast.markers.join(" · ")}.` : ""}</p>
      </div>
    );
  }
  const size = kind === "frame" ? frameSize(loaded.text) : { cols: 120, rows: 40 };
  return (
    <TerminalWindow title={`${artifact.title} — ${size.cols}×${size.rows}${kind === "frame" ? " — hand-written frame" : " — transcript"}`}>
      <TerminalText lines={renderAnsi(loaded.text, size)} cols={size.cols} rows={kind === "frame" ? size.rows : 1} label={`${kind === "frame" ? "Frame" : "Transcript"} ${path}`} />
    </TerminalWindow>
  );
}

/** A recorded terminal demo: the webm (or the gif) at its recorded size, in a window. */
export function TerminalRecording({ title, video, gif }: { title: string; video?: string; gif?: string }) {
  return (
    <TerminalWindow title={`${title} — recorded`}>
      {video ? (
        <video className="st-term__media" src={video} controls muted loop playsInline preload="metadata" aria-label={`Recording of ${title}`} />
      ) : (
        <img className="st-term__media" src={gif} alt={`Recording of ${title}`} />
      )}
    </TerminalWindow>
  );
}
