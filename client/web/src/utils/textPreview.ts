// ACT: 附件文本预览判别：按文件名扩展名 + MIME 决定主面板的渲染形态；
// 返回 null 表示不可文本预览（如 Word/PDF/二进制），点击仍走下载。
export type TextPreviewKind = "text" | "json" | "markdown" | "html";

const JSON_EXT = ["json"];
const MD_EXT = ["md", "markdown", "mdown"];
const HTML_EXT = ["html", "htm", "xhtml"];
// ACT: 常见源码/配置/纯文本扩展名：MIME 常报 octet-stream，只能靠扩展名兜底。
const TEXT_EXT = [
  "txt", "log", "csv", "tsv", "xml", "yml", "yaml", "toml", "ini", "conf", "cfg",
  "css", "scss", "less", "js", "jsx", "ts", "tsx", "vue", "py", "go", "rs", "java",
  "c", "h", "cpp", "hpp", "cc", "sh", "bash", "zsh", "sql", "env", "gitignore", "editorconfig",
];
// ACT: 无扩展名的惯用文本文件（如截图里的 LICENSE）：按整名或去点名匹配。
const TEXT_NAMES = ["license", "licence", "readme", "makefile", "dockerfile", "authors", "notice", "changelog", "gemfile", "rakefile"];

export function previewKind(name: string, mimetype: string): TextPreviewKind | null {
  const lower = (name || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  const base = dot >= 0 ? lower.slice(0, dot) : lower;
  const mime = (mimetype || "").toLowerCase();
  if (JSON_EXT.includes(ext) || mime === "application/json") return "json";
  if (MD_EXT.includes(ext)) return "markdown";
  if (HTML_EXT.includes(ext) || mime === "text/html") return "html";
  if (mime.startsWith("text/")) return "text";
  if (TEXT_EXT.includes(ext)) return "text";
  if (TEXT_NAMES.includes(lower) || TEXT_NAMES.includes(base)) return "text";
  return null;
}
