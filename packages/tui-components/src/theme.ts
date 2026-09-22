import type { Layout, Pane } from "./index";

export interface SemanticRowTheme {
  foreground: string;
  background: string;
  marker: string;
}
export interface TuiTheme {
  background: string;
  surface: string;
  surfaceRaised: string;
  text: string;
  textMuted: string;
  accent: string;
  focus: string;
  selectionBackground: string;
  hunkText: string;
  border: string;
  warning: string;
  error: string;
  diff: {
    context: SemanticRowTheme;
    addition: SemanticRowTheme;
    deletion: SemanticRowTheme;
  };
}

export const darkTheme: TuiTheme = {
  background: "#15191f",
  surface: "#20252d",
  surfaceRaised: "#282e38",
  text: "#d8dde5",
  textMuted: "#929aa8",
  accent: "#55c8e8",
  focus: "#55c8e8",
  selectionBackground: "#244854",
  hunkText: "#aab2c0",
  border: "#46505c",
  warning: "#e8c45a",
  error: "#ff6b5f",
  diff: {
    context: { foreground: "#d8dde5", background: "#15191f", marker: " " },
    addition: { foreground: "#79df98", background: "#10351e", marker: "+" },
    deletion: { foreground: "#ff9188", background: "#3a191b", marker: "-" },
  },
};

export function panesForLayout(
  layout: Layout,
  focusedPane: Pane,
  annotationCount: number,
): Pane[] {
  if (layout === "narrow") return [focusedPane];
  if (focusedPane === "annotations" && annotationCount > 0)
    return ["annotations", "content"];
  return ["documents", "content"];
}
