export type SearchStatus = {
  current: number;
  total: number;
};

export interface DocumentViewerController {
  readonly kind: "xlsx" | "pptx";
  clearSearch(): void;
  destroy(): void;
  getPageLabel(): string;
  moveMatch(delta: 1 | -1): SearchStatus;
  search(query: string): SearchStatus;
}
