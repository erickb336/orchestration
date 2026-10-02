// Document artifacts (ORC-029 pass 4a): interfaces, algorithms, topologies, contracts and flows, shown as documents
// with no device frame. Markdown with code blocks and tables, and Mermaid diagrams, read through the app's own
// service (GET /api/studio/file, text/plain), never from the prototype server.
//
// What an agent wrote is untrusted. Markdown is rendered to React elements (react-markdown, with GitHub's tables
// from remark-gfm): raw HTML is never rendered (it shows as text), links open outside the app only when they are
// http(s), and images load only from the version's own files. Mermaid never runs in the app's page: while it lays a
// diagram out, some of its syntax loads URLs (pass 4 review, finding 2). It runs in a sandboxed frame that can reach
// nothing (diagrams.ts), at securityLevel "strict", with the keys a diagram's own directives could use to add CSS or
// URLs or to relax it locked. The app shows the SVG it returns as an image, where nothing runs or loads. The app
// page's own policy (server/http.ts) allows no request outside the app either.

import { useEffect, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MermaidConfig } from "mermaid";
import type { StudioArtifact } from "../../domain/studio/types";
import { EmptyState } from "../kit";
import { drawDiagram } from "./diagrams";
import { useServiceText } from "./Frames";
import { documentFiles, documentType, resolveInVersion, serviceFileUrl } from "./studioView";

/** The tokens the diagrams take their look from (styles.css); read once, when the first diagram is drawn. */
const DIAGRAM_TOKENS = { background: "--surface", primaryColor: "--surface-2", secondaryColor: "--surface", tertiaryColor: "--bg", mainBkg: "--surface-2", primaryTextColor: "--text", textColor: "--text", primaryBorderColor: "--border-strong", nodeBorder: "--border-strong", lineColor: "--muted", clusterBkg: "--bg", clusterBorder: "--border-strong", edgeLabelBackground: "--surface", noteBkgColor: "--surface-2", noteTextColor: "--text", noteBorderColor: "--border-strong", actorBkg: "--surface-2", actorBorder: "--border-strong", actorTextColor: "--text", signalColor: "--text", signalTextColor: "--text" } as const;

/**
 * Mermaid's settings: strict security, no start on load, labels as SVG text (no HTML), and errors returned rather
 * than drawn. `secure` lists the keys a diagram's own `%%{init}%%` directive or front matter cannot change: Mermaid's
 * defaults, the labels, the sanitiser's settings, the look, and every key that adds CSS or a URL (themeCSS, the fonts,
 * absolute arrow-marker URLs, KaTeX's stylesheet mode). `token` reads a design token's value ("" when unset).
 */
export function mermaidConfig(token: (name: string) => string): MermaidConfig {
  const themeVariables: Record<string, string | boolean> = { darkMode: true, fontSize: "14px" };
  for (const [key, name] of Object.entries(DIAGRAM_TOKENS)) {
    const value = token(name).trim();
    if (value) themeVariables[key] = value;
  }
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: "base",
    darkMode: true,
    fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    themeVariables,
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "htmlLabels", "dompurifyConfig", "theme", "themeVariables", "darkMode", "fontFamily", "altFontFamily", "themeCSS", "arrowMarkerAbsolute", "legacyMathML", "forceLegacyMathML"],
  };
}

let config: MermaidConfig | undefined;
/** The settings, with the design tokens read once, when the first diagram is drawn. */
function diagramConfig(): MermaidConfig {
  if (!config) {
    const style = getComputedStyle(document.documentElement);
    config = mermaidConfig((name) => style.getPropertyValue(name));
  }
  return config;
}

/** Mermaid's SVG as an image: sized from its viewBox, as a data URL. Nothing in an image runs or loads. */
function svgImage(svg: string): { src: string; width?: number; height?: number } {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg") throw new Error("Mermaid's drawing is not an SVG");
  const box = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const [width, height] = box.length === 4 && box.every(Number.isFinite) ? [Math.ceil(box[2]), Math.ceil(box[3])] : [undefined, undefined];
  if (width && height) {
    root.setAttribute("width", String(width));
    root.setAttribute("height", String(height));
    root.removeAttribute("style");
  }
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`, width, height };
}

/** The smallest a diagram is drawn, as a share of its size; below it, the diagram scrolls in its box. */
const MIN_DIAGRAM_SCALE = 0.6;

type Drawn = { status: "drawing" } | { status: "ok"; src: string; width?: number; height?: number } | { status: "error"; message: string };

/** A Mermaid diagram, drawn in the diagram frame, with its source under it. `label` says what it is, for the image's text alternative. */
export function MermaidDiagram({ source, label }: { source: string; label: string }) {
  const [drawn, setDrawn] = useState<{ source: string; value: Drawn }>({ source, value: { status: "drawing" } });
  useEffect(() => {
    let live = true;
    drawDiagram(source, diagramConfig()).then(svgImage).then(
      (img) => live && setDrawn({ source, value: { status: "ok", ...img } }),
      (e: unknown) => live && setDrawn({ source, value: { status: "error", message: (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300) } }),
    );
    return () => {
      live = false;
    };
  }, [source]);
  const value = drawn.source === source ? drawn.value : { status: "drawing" as const };
  return (
    <figure className="st-doc__diagram">
      {value.status === "ok" ? (
        <div className="st-doc__drawing">
          <img src={value.src} width={value.width} height={value.height} alt={label} style={value.width ? { minWidth: Math.round(value.width * MIN_DIAGRAM_SCALE) } : undefined} />
        </div>
      ) : value.status === "error" ? (
        <p className="small muted">The diagram cannot be drawn: {value.message}</p>
      ) : (
        <p className="small muted">Drawing the diagram…</p>
      )}
      <details className="st-doc__source">
        <summary className="small muted">Diagram source</summary>
        <pre className="st-doc__code">
          <code>{source}</code>
        </pre>
      </details>
    </figure>
  );
}

/** The text of a hast node and its children (a code block's source). */
type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };
const textOf = (n: HastNode | undefined): string => (!n ? "" : n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(textOf).join(""));

/**
 * How Markdown's elements are drawn: headings two levels down (the page has its own), code blocks monospaced and a
 * `mermaid` block as a diagram, tables in a box that scrolls on its own, links out of the app in a new tab only when
 * they are http(s), and images only from the version's own files.
 */
function components(artifact: StudioArtifact, path: string): Components {
  const heading =
    (Tag: "h3" | "h4" | "h5" | "h6") =>
    ({ children }: { children?: ReactNode }) => <Tag className="st-doc__h">{children}</Tag>;
  return {
    h1: heading("h3"),
    h2: heading("h4"),
    h3: heading("h5"),
    h4: heading("h6"),
    h5: heading("h6"),
    h6: heading("h6"),
    pre: ({ node, children }) => {
      const code = (node as HastNode | undefined)?.children?.find((c) => c.type === "element" && c.tagName === "code");
      const classes = code?.properties?.className;
      if (Array.isArray(classes) && classes.includes("language-mermaid")) return <MermaidDiagram source={textOf(code).replace(/\n$/, "")} label={`A diagram in ${path}`} />;
      return <pre className="st-doc__code">{children}</pre>;
    },
    table: ({ children }) => (
      <div className="st-doc__table">
        <table>{children}</table>
      </div>
    ),
    a: ({ href, children }) =>
      href && /^https?:\/\//i.test(href) ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ) : (
        <span className="st-doc__link">{children}</span>
      ),
    img: ({ src, alt }) => {
      const own = typeof src === "string" ? resolveInVersion(path, src) : undefined;
      if (own && /\.(png|gif)$/i.test(own) && artifact.files.some((f) => f.path === own)) return <img src={serviceFileUrl(artifact, own)} alt={alt ?? ""} className="st-doc__img" />;
      return <span className="muted">[Image{alt ? `: ${alt}` : ""}, not shown: only the artifact's own PNG and GIF files are.]</span>;
    },
  };
}

const PLUGINS = [remarkGfm];

/** A Markdown document, rendered safely: React elements only, raw HTML as text. */
export function MarkdownDoc({ text, artifact, path }: { text: string; artifact: StudioArtifact; path: string }) {
  return (
    <div className="st-doc__md">
      <Markdown remarkPlugins={PLUGINS} components={components(artifact, path)}>
        {text}
      </Markdown>
    </div>
  );
}

/** One file of a document artifact, read through the app's own service, drawn by its type. */
function DocumentFile({ artifact, path, named }: { artifact: StudioArtifact; path: string; named: boolean }) {
  const loaded = useServiceText(serviceFileUrl(artifact, path));
  const type = documentType(path);
  return (
    <section className="st-doc__file" aria-label={path}>
      {named && <p className="micro muted st-doc__path">{path}</p>}
      {loaded.status === "loading" ? (
        <p className="small muted">Reading {path}…</p>
      ) : loaded.status === "error" ? (
        <p className="small muted">
          {path} cannot be shown: {loaded.message}.
        </p>
      ) : type === "mermaid" ? (
        <MermaidDiagram source={loaded.text} label={`The diagram in ${path}`} />
      ) : type === "markdown" ? (
        <MarkdownDoc text={loaded.text} artifact={artifact} path={path} />
      ) : (
        <pre className="st-doc__code">
          <code>{loaded.text}</code>
        </pre>
      )}
    </section>
  );
}

/** A document artifact's variant: its document files one after another, or why there is nothing to show. */
export function DocumentArtifact({ artifact, variant }: { artifact: StudioArtifact; variant: string | undefined }) {
  const paths = documentFiles(artifact, variant);
  if (!paths.length) {
    return <EmptyState title="No document to show">The designer handed in no Markdown (.md), Mermaid (.mmd) or text file for this {artifact.variants.length > 1 ? "variant" : "artifact"}.</EmptyState>;
  }
  return (
    <article className="st-doc" aria-label={`${artifact.title}, a document`}>
      {paths.map((p) => (
        <DocumentFile key={p} artifact={artifact} path={p} named={paths.length > 1} />
      ))}
    </article>
  );
}
