export * from "./review-stream";
export * from "./theme";

export type Pane = "documents" | "content" | "annotations";
export interface Selection {
  anchor: number;
  focus: number;
}
export type TuiMode =
  | "browse"
  | "compose"
  | "help"
  | "command"
  | "confirm-delete"
  | "confirm-finish"
  | "confirm-exit";
export interface TuiState {
  documentIndex: number;
  rowIndex: number;
  navigatorIndex: number;
  annotationIndex: number;
  pane: Pane;
  mode: TuiMode;
  selection?: Selection;
  pendingChord?: "[" | "]" | "g";
  help: boolean;
  composing: boolean;
}
export type TuiAction =
  | { type: "move-row"; delta: number; rowCount: number }
  | { type: "move-document"; delta: number; documentCount: number }
  | { type: "move-annotation"; delta: number; annotationCount: number }
  | { type: "set-annotation"; index: number; annotationCount: number }
  | { type: "move-navigator"; delta: number; itemCount: number }
  | { type: "set-navigator"; index: number; itemCount: number }
  | { type: "set-document"; index: number; rowIndex?: number }
  | { type: "set-row"; index: number; rowCount: number }
  | { type: "set-mode"; mode: TuiMode }
  | { type: "set-pane"; pane: Pane }
  | { type: "set-pending-chord"; chord?: "[" | "]" | "g" }
  | { type: "select" }
  | { type: "clear-selection" }
  | { type: "next-pane"; reverse?: boolean }
  | { type: "help" }
  | { type: "compose"; value: boolean };
export const initialTuiState: TuiState = {
  documentIndex: 0,
  rowIndex: 0,
  navigatorIndex: 0,
  annotationIndex: 0,
  pane: "content",
  mode: "browse",
  help: false,
  composing: false,
};
const clamp = (value: number, max: number) =>
  Math.max(0, Math.min(value, Math.max(0, max - 1)));
export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  if (action.type === "move-row") {
    const rowIndex = clamp(state.rowIndex + action.delta, action.rowCount);
    return {
      ...state,
      rowIndex,
      ...(state.selection
        ? { selection: { ...state.selection, focus: rowIndex } }
        : {}),
    };
  }
  if (action.type === "move-document")
    return {
      ...state,
      documentIndex: clamp(
        state.documentIndex + action.delta,
        action.documentCount,
      ),
      rowIndex: 0,
      selection: undefined,
    };
  if (action.type === "set-annotation")
    return {
      ...state,
      annotationIndex: clamp(action.index, action.annotationCount),
    };
  if (action.type === "move-navigator")
    return {
      ...state,
      pane: "documents",
      navigatorIndex: clamp(
        state.navigatorIndex + action.delta,
        action.itemCount,
      ),
    };
  if (action.type === "set-navigator")
    return {
      ...state,
      navigatorIndex: clamp(action.index, action.itemCount),
    };
  if (action.type === "set-document")
    return {
      ...state,
      documentIndex: action.index,
      rowIndex: action.rowIndex ?? 0,
      selection: undefined,
      pane: "content",
    };
  if (action.type === "set-row")
    return {
      ...state,
      rowIndex: clamp(action.index, action.rowCount),
      selection: undefined,
    };
  if (action.type === "move-annotation")
    return {
      ...state,
      pane: "annotations",
      annotationIndex: clamp(
        state.annotationIndex + action.delta,
        action.annotationCount,
      ),
    };
  if (action.type === "set-mode")
    return {
      ...state,
      mode: action.mode,
      help: action.mode === "help",
      composing: action.mode === "compose",
    };
  if (action.type === "set-pane") return { ...state, pane: action.pane };
  if (action.type === "set-pending-chord")
    return { ...state, pendingChord: action.chord };
  if (action.type === "select")
    return state.selection
      ? { ...state, selection: undefined }
      : {
          ...state,
          selection: { anchor: state.rowIndex, focus: state.rowIndex },
        };
  if (action.type === "clear-selection")
    return { ...state, selection: undefined };
  if (action.type === "next-pane") {
    const panes: Pane[] = ["documents", "content", "annotations"];
    const offset = action.reverse ? -1 : 1;
    return {
      ...state,
      pane: panes[
        (panes.indexOf(state.pane) + offset + panes.length) % panes.length
      ]!,
    };
  }
  if (action.type === "help")
    return {
      ...state,
      help: !state.help,
      mode: state.mode === "help" ? "browse" : "help",
    };
  return {
    ...state,
    composing: action.value,
    mode: action.value ? "compose" : "browse",
  };
}
export type TuiCommand =
  | "move-down"
  | "move-up"
  | "half-page-down"
  | "half-page-up"
  | "top"
  | "bottom"
  | "next-pane"
  | "previous-pane"
  | "select-range"
  | "comment-range"
  | "comment-document"
  | "comment-surface"
  | "old-side"
  | "new-side"
  | "toggle-wrap"
  | "toggle-inspected"
  | "next-document"
  | "previous-document"
  | "next-heading"
  | "previous-heading"
  | "next-annotation"
  | "previous-annotation"
  | "edit-annotation"
  | "delete-annotation"
  | "save-comment"
  | "save-session"
  | "finish"
  | "help"
  | "commands"
  | "back";
export interface KeyStroke {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
}
export interface ResolvedKey {
  state: TuiState;
  action?: TuiCommand;
}
interface Binding {
  action: TuiCommand;
  keys: string;
  hint: string;
  panes?: Pane[];
  modes?: TuiMode[];
  footer?: boolean;
}
const browse = ["browse"] satisfies TuiMode[];
const content = ["content"] satisfies Pane[];
const annotations = ["annotations"] satisfies Pane[];
const bindings: Binding[] = [
  { action: "move-down", keys: "j/↓", hint: "j/k move", modes: browse },
  {
    action: "move-up",
    keys: "k/↑",
    hint: "k move up",
    modes: browse,
    footer: false,
  },
  {
    action: "half-page-down",
    keys: "Ctrl-d",
    hint: "Ctrl-d/u page",
    modes: browse,
    footer: false,
  },
  {
    action: "half-page-up",
    keys: "Ctrl-u",
    hint: "Ctrl-u page up",
    modes: browse,
    footer: false,
  },
  { action: "top", keys: "gg", hint: "gg top", modes: browse, footer: false },
  {
    action: "bottom",
    keys: "G",
    hint: "G bottom",
    modes: browse,
    footer: false,
  },
  {
    action: "next-pane",
    keys: "Tab",
    hint: "Tab focus",
    modes: browse,
    footer: false,
  },
  {
    action: "previous-pane",
    keys: "Shift-Tab",
    hint: "Shift-Tab previous focus",
    modes: browse,
    footer: false,
  },
  {
    action: "select-range",
    keys: "v",
    hint: "v select",
    panes: content,
    modes: browse,
  },
  {
    action: "comment-range",
    keys: "c",
    hint: "c comment",
    panes: content,
    modes: browse,
  },
  {
    action: "finish",
    keys: "r",
    hint: "r finish",
    modes: browse,
  },
  {
    action: "comment-document",
    keys: "C",
    hint: "C document comment",
    panes: content,
    modes: browse,
    footer: false,
  },
  {
    action: "comment-surface",
    keys: "A",
    hint: "A surface comment",
    modes: browse,
    footer: false,
  },
  {
    action: "toggle-inspected",
    keys: "m",
    hint: "m inspected",
    modes: browse,
    footer: false,
  },
  {
    action: "next-document",
    keys: "]d",
    hint: "]d next document",
    modes: browse,
  },
  {
    action: "previous-document",
    keys: "[d",
    hint: "[d previous document",
    modes: browse,
    footer: false,
  },
  {
    action: "next-heading",
    keys: "]h",
    hint: "]h hunk/heading",
    panes: ["content", "documents"],
    modes: browse,
  },
  {
    action: "previous-heading",
    keys: "[h",
    hint: "[h previous heading",
    panes: ["content", "documents"],
    modes: browse,
    footer: false,
  },
  {
    action: "next-annotation",
    keys: "]a",
    hint: "]a next annotation",
    modes: browse,
    footer: false,
  },
  {
    action: "previous-annotation",
    keys: "[a",
    hint: "[a previous annotation",
    modes: browse,
    footer: false,
  },
  {
    action: "edit-annotation",
    keys: "e",
    hint: "e edit",
    panes: annotations,
    modes: browse,
  },
  {
    action: "delete-annotation",
    keys: "d",
    hint: "d delete",
    panes: annotations,
    modes: browse,
  },
  {
    action: "old-side",
    keys: "h",
    hint: "h/l diff side",
    panes: content,
    modes: browse,
    footer: false,
  },
  {
    action: "new-side",
    keys: "l",
    hint: "l new side",
    panes: content,
    modes: browse,
    footer: false,
  },
  {
    action: "toggle-wrap",
    keys: "w",
    hint: "w wrap",
    panes: content,
    modes: browse,
    footer: false,
  },
  {
    action: "save-comment",
    keys: "Ctrl-s",
    hint: "Ctrl-s save comment",
    modes: ["compose"],
  },
  { action: "help", keys: "?", hint: "? help", modes: browse },
  {
    action: "back",
    keys: "Esc/q",
    hint: "q back/quit",
    modes: [
      "browse",
      "compose",
      "help",
      "command",
      "confirm-delete",
      "confirm-finish",
      "confirm-exit",
    ],
    footer: false,
  },
  {
    action: "save-session",
    keys: "s",
    hint: "s save",
    modes: browse,
    footer: false,
  },
  { action: "commands", keys: ":", hint: ": commands", modes: browse },
];
function available(binding: Binding, state: TuiState): boolean {
  return (
    (!binding.panes || binding.panes.includes(state.pane)) &&
    (!binding.modes || binding.modes.includes(state.mode))
  );
}
export interface ActionItem {
  action: TuiCommand;
  keys: string;
  label: string;
}
export function availableActions(state: TuiState): ActionItem[] {
  return bindings
    .filter((binding) => available(binding, state))
    .map((binding) => ({
      action: binding.action,
      keys: binding.keys,
      label: binding.hint.replace(/^\S+\s+/, ""),
    }));
}
export function actionHints(state: TuiState): string[] {
  return bindings
    .filter((binding) => available(binding, state) && binding.footer !== false)
    .map((binding) => binding.hint);
}
export function resolveKey(state: TuiState, key: KeyStroke): ResolvedKey {
  if (state.pendingChord) {
    const chord = `${state.pendingChord}${key.name}`;
    const actions: Record<string, TuiCommand> = {
      "]d": "next-document",
      "[d": "previous-document",
      "]a": "next-annotation",
      "[a": "previous-annotation",
      "]h": "next-heading",
      "[h": "previous-heading",
      gg: "top",
    };
    return {
      state: { ...state, pendingChord: undefined },
      ...(actions[chord] ? { action: actions[chord] } : {}),
    };
  }
  if (state.mode === "compose") {
    if (key.ctrl && key.name === "s") return { state, action: "save-comment" };
    if (key.name === "escape") return { state, action: "back" };
    return { state };
  }
  if (key.shift && key.name === "g") return { state, action: "bottom" };
  if (key.name === "]" || key.name === "[" || key.name === "g")
    return { state: { ...state, pendingChord: key.name } };
  if (key.name === "j" || key.name === "down")
    return { state, action: "move-down" };
  if (key.name === "k" || key.name === "up")
    return { state, action: "move-up" };
  if (key.name === "tab")
    return { state, action: key.shift ? "previous-pane" : "next-pane" };
  if (key.ctrl && key.name === "d") return { state, action: "half-page-down" };
  if (key.ctrl && key.name === "u") return { state, action: "half-page-up" };
  const direct: Record<string, TuiCommand> = {
    v: "select-range",
    c: key.shift ? "comment-document" : "comment-range",
    a: key.shift ? "comment-surface" : "next-annotation",
    h: "old-side",
    l: "new-side",
    w: "toggle-wrap",
    m: "toggle-inspected",
    e: "edit-annotation",
    d: "delete-annotation",
    s: "save-session",
    r: "finish",
    "?": "help",
    ":": "commands",
    escape: "back",
    q: "back",
  };
  const action = direct[key.name];
  if (!action) return { state };
  const binding = bindings.find((item) => item.action === action);
  return binding && !available(binding, state) ? { state } : { state, action };
}
export function isEnterKey(name: string): boolean {
  return name === "enter" || name === "return";
}
export function fitHints(hints: string[], width: number): string {
  let output = "";
  for (const hint of hints) {
    const candidate = output ? `${output} · ${hint}` : hint;
    if (candidate.length > width) break;
    output = candidate;
  }
  return output;
}
export type Layout = "wide" | "medium" | "narrow";
export function layoutForWidth(width: number): Layout {
  return width < 70 ? "narrow" : width < 110 ? "medium" : "wide";
}
export function selectionBounds(
  selection: Selection | undefined,
  fallback: number,
): [number, number] {
  return selection
    ? [
        Math.min(selection.anchor, selection.focus),
        Math.max(selection.anchor, selection.focus),
      ]
    : [fallback, fallback];
}
