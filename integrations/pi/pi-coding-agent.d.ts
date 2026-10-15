// The one runtime export of Pi this extension uses. Pi aliases the package for
// extensions at load time; it is not a dependency of the Schlop workspace.
declare module "@earendil-works/pi-coding-agent" {
  export class TreeSelectorComponent {
    constructor(
      tree: unknown[],
      currentLeafId: string | null,
      terminalHeight: number,
      onSelect: (entryId: string) => void,
      onCancel: () => void,
      onLabelChange?: (entryId: string, label: string | undefined) => void,
      initialSelectedId?: string,
      initialFilterMode?:
        "default" | "no-tools" | "user-only" | "labeled-only" | "all",
    );
    render(width: number): string[];
    invalidate(): void;
  }
}
