export type StashKind = "web" | "repo" | "pdf" | "image" | "note" | "file";

export type StashOrigin = {
  platform: string;
  importMethod: "bookmark_html" | "browser_bookmarks" | "browser_extension" | "manual_url" | "local_file" | "note" | "platform_import" | "ai_context";
  contentOrigin?: 'provided' | 'generated';
  pendingTitle?: string;
  contentEdited?: boolean;
  contentSettled?: boolean;
  sourceUrls?: string[];
  externalId?: string;
  author?: string;
  folderPath?: string[];
  savedAt?: string;
  publishedAt?: string;
  captureMethod?: 'page' | 'selection';
  truncated?: boolean;
  faviconUrl?: string;
  previewKind?: 'screenshot' | 'cover';
  previewSource?: 'custom';
  fileName?: string;
  importedAt: string;
};

export type StashItem = {
  id: string;
  title: string;
  kind: StashKind;
  source: string;
  url?: string;
  excerpt: string;
  tags: string[];
  createdAt: string;
  favorite?: boolean;
  useCount?: number;
  preview?: string;
  previewStatus?: "queued" | "working" | "failed" | "unavailable";
  contentStatus?: "queued" | "working" | "failed" | "done";
  assetPath?: string;
  originalPath?: string;
  mimeType?: string;
  sizeBytes?: number;
  hasFile?: boolean;
  content?: string;
  contextOverride?: string;
  origin?: StashOrigin;
};

export type CollectionFilter = "all" | "recent" | "web" | "files" | "favorites";
