// The new-project form's confirmation, as a pure decision so it can be tested without a browser. Every project
// begins by shaping its vision, so the form offers no choice of stage.

/** The confirmation before replacing the project, saying what is lost: the board, the history, and any vision documents. */
export function initProjectConfirm(name: string, docCount: number): string {
  const one = docCount === 1;
  const docs = docCount
    ? ` The ${docCount} vision document${one ? "" : "s"} attached to the current project ${one ? "is" : "are"} removed too, and ${one ? "its copy is" : "their copies are"} deleted from disk; attach ${one ? "it" : "them"} again to the new project if you still need ${one ? "it" : "them"}.`
    : "";
  return `Start a new project "${name}"? The current board and history are replaced.${docs}`;
}
