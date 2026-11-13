<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { translate } from "@dsh-movie/i18n/vue";
import { useMatrixChat } from "@/composables/useMatrixChat";
// ACT: 播放/暂停字形取自 src/icons 的描边 SVG（与画笔工具箱同 1.9 描边），经 mask + currentColor 着色。
import iconVideoPlay from "@/icons/video_play.svg";
import iconVideoPause from "@/icons/video_pause.svg";
// ACT: 图片模式控制条的缩小/放大字形：用户指定的 iconfont 实心 SVG，同样走 mask + currentColor。
import iconZoomOut from "@/icons/zoom_out.svg";
import iconZoomIn from "@/icons/zoom_in.svg";
// ACT: Markdown 渲染复用仓内既有组合（marked 解析 + DOMPurify 白名单净化），与 packages/ext/md 同源。
import DOMPurify from "dompurify";
import { marked } from "marked";
// ACT: 文本模式截图：html2canvas-pro 把阅读面按所见即所得光栅化（仓内 director3dNode 同款依赖）。
import html2canvas from "html2canvas-pro";
// ACT: 无视频空态插画改用胶片图标：经 mask + 分隔线同色渲染，宽度仍为 el-empty 默认 160px。
import iconEmptyFilm from "@/icons/canvas_film.svg";

// ACT: 群聊页左侧「视频播放与截图」舞台：播放器 + 自定义控制条 + 画笔工具箱。
// 画笔层移植自 mesh-controller-codegen 的 MeshViewer：标记以归一化坐标存储（0..1），
// 面板缩放不丢笔迹；截图时把视频帧与画笔层合成一张 PNG（同源 blob 不污染 canvas）。
export type StageVideo = { id: string; url: string; name: string };

const props = defineProps<{ items: StageVideo[]; modelValue: string; playToken?: number; image?: { url: string; name: string } | null; text?: { name: string; content: string; kind: "text" | "json" | "markdown" | "html" } | null }>();
const emit = defineEmits<{ "update:modelValue": [id: string] }>();

const { ready, activeRoomId, sendImage } = useMatrixChat();

// ── 选择：用户未点选时自动跟随最新一条 ──
const current = computed(() => props.items.find(item => item.id === props.modelValue) ?? null);
watch(() => props.items, list => {
  if (list.some(item => item.id === props.modelValue)) return;
  emit("update:modelValue", list.length ? list[list.length - 1].id : "");
}, { immediate: true, deep: false });

// ── 播放器状态 ──
const videoRef = ref<HTMLVideoElement>();
const playing = ref(false);
const duration = ref(0);
const currentTime = ref(0);
const aspect = ref(16 / 9);
const sliding = ref(false);
const scrub = ref(0);

function fmt(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function onMeta() {
  const video = videoRef.value;
  if (!video) return;
  duration.value = Number.isFinite(video.duration) ? video.duration : 0;
  if (video.videoWidth && video.videoHeight) aspect.value = video.videoWidth / video.videoHeight;
  sizeInk();
}
function onTime() {
  const video = videoRef.value;
  if (video) currentTime.value = video.currentTime;
}
async function togglePlay() {
  const video = videoRef.value;
  if (!video || !current.value) return;
  if (video.paused) await video.play().catch(() => { playing.value = false; });
  else video.pause();
}
function onScrubDown() { sliding.value = true; scrub.value = currentTime.value; }
function onScrubUp() { sliding.value = false; }
function onScrubInput(event: Event) {
  const video = videoRef.value;
  if (!video) return;
  const value = Number((event.target as HTMLInputElement).value);
  scrub.value = value;
  video.currentTime = value;
  currentTime.value = value;
}

// ACT: 换片即清笔迹——标记属于某一帧/某一片，跨片保留只会造成误解。
watch(current, () => {
  playing.value = false;
  currentTime.value = 0;
  scrub.value = 0;
  clearMarks();
  void nextTick(sizeInk);
});

// ACT: 右键菜单「播放」：playToken 递增时自动起播当前选中视频（仅响应变化，挂载不播）；
// 换片与增 token 同帧发生时，nextTick 后 video 已换新 src，play() 由浏览器等待就绪。
watch(() => props.playToken, token => {
  if (!token || !current.value) return;
  void nextTick(() => {
    void videoRef.value?.play().catch(() => { playing.value = false; });
  });
});

// ── 图片模式：时间线点击图片后与视频播放器同位展示 ──
// ACT: 有 image 时舞台切换为图片展示：控制条只留缩小/放大两键（替换播放/暂停、滑杆与时间盒）并居中，
// 画笔工具箱保留在控制条下方；最大显示窗（盒子）不画黑底不画边框，图片小于最大窗时按原生尺寸居中。
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;
const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);
const panning = ref(false);
const imageAspect = ref(16 / 9);
// ACT: 基准缩放＝图片原生尺寸相对最大显示窗的 fitting 比（大于窗为 1，小于窗则<1 不放大）；
// 缩放键的上下限按基准的倍数算，小图不会被允许放大到糊。
const baseScale = ref(1);
const zoomMin = computed(() => baseScale.value * ZOOM_MIN);
const zoomMax = computed(() => baseScale.value * ZOOM_MAX);
// ACT: 文本模式字号缩放范围（图片模式仍走基准比例界限）：14px 的 0.5–4 倍。
const TEXT_ZOOM_MIN = 0.5;
const TEXT_ZOOM_MAX = 4;
let panFrom = { x: 0, y: 0, ox: 0, oy: 0 };

// ACT: 盒子宽高比：图片模式跟随图片原生比例（加载后回填），视频模式仍跟视频，空态/文本态不锁比例。
const boxStyle = computed(() => {
  if (props.text) return null;
  if (props.image) return { aspectRatio: `${imageAspect.value}` };
  return current.value ? { aspectRatio: `${aspect.value}` } : null;
});

// ACT: Markdown 走 marked(gfm) + DOMPurify 白名单净化：禁 style/form，上传文档不能污染主页或夹带脚本。
const markdownHtml = computed(() => {
  if (!props.text || props.text.kind !== "markdown") return "";
  const raw = marked.parse(props.text.content, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form"] }) as string;
});

// ACT: JSON 能解析则两空格缩进重排便于阅读；解析失败回退原文（不臆造）。
const jsonText = computed(() => {
  if (!props.text || props.text.kind !== "json") return "";
  try {
    return JSON.stringify(JSON.parse(props.text.content), null, 2);
  } catch {
    return props.text.content;
  }
});

// ACT: HTML 形态：sandbox 空属性 iframe（禁脚本、禁同源）隔离渲染，并注入当前字号；主页面不受上传文档影响。
const htmlDoc = computed(() => {
  if (!props.text || props.text.kind !== "html") return "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>html{font-size:${14 * zoom.value}px}</style></head><body>${props.text.content}</body></html>`;
});

function onImageLoad(event: Event) {
  const img = event.target as HTMLImageElement;
  if (img.naturalWidth && img.naturalHeight) imageAspect.value = img.naturalWidth / img.naturalHeight;
  // ACT: 盒子宽高比刚回填，等下一帧盒子按新比例重排后再量宽算基准缩放。
  void nextTick(applyFit);
}

// ACT: 基准缩放：图片原生宽 / 最大显示窗宽，大于 1（图比窗大）时取 1 即 fitting 缩到窗内；
// 用户没动过缩放时跟随基准（含窗口 resize），动过则只重新夹紧平移。
function computeBaseScale() {
  const box = boxRef.value;
  const img = imageEl.value;
  if (!box || !img || !box.clientWidth || !img.naturalWidth) return 1;
  return Math.min(1, img.naturalWidth / box.clientWidth);
}
function applyFit() {
  const base = computeBaseScale();
  const untouched = Math.abs(zoom.value - baseScale.value) < 1e-6;
  baseScale.value = base;
  if (untouched) { zoom.value = base; panX.value = 0; panY.value = 0; }
  else clampPan();
}

// ACT: 平移量夹紧到缩放溢出的范围，图片边缘不会拖出盒子露底；回到 1 倍时由 zoomBy 归零居中。
function clampPan() {
  const box = boxRef.value;
  if (!box) return;
  const maxX = Math.max(0, ((zoom.value - 1) * box.clientWidth) / 2);
  const maxY = Math.max(0, ((zoom.value - 1) * box.clientHeight) / 2);
  panX.value = Math.min(maxX, Math.max(-maxX, panX.value));
  panY.value = Math.min(maxY, Math.max(-maxY, panY.value));
}

function zoomBy(factor: number) {
  const min = props.text ? TEXT_ZOOM_MIN : zoomMin.value;
  const max = props.text ? TEXT_ZOOM_MAX : zoomMax.value;
  zoom.value = Math.min(max, Math.max(min, zoom.value * factor));
  if (zoom.value <= 1) { panX.value = 0; panY.value = 0; }
  else clampPan();
}

function panDown(event: PointerEvent) {
  if (zoom.value <= 1) return;
  event.preventDefault();
  panning.value = true;
  panFrom = { x: event.clientX, y: event.clientY, ox: panX.value, oy: panY.value };
  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
}
function panMove(event: PointerEvent) {
  if (!panning.value) return;
  panX.value = panFrom.ox + (event.clientX - panFrom.x);
  panY.value = panFrom.oy + (event.clientY - panFrom.y);
  clampPan();
}
function panUp() { panning.value = false; }

// ACT: 换图/收回图片都重置缩放、平移与笔迹（标记属于当前展示内容）；canvas 尺寸补测一次。
watch(() => props.image, img => {
  zoom.value = 1;
  baseScale.value = 1;
  panX.value = 0;
  panY.value = 0;
  panning.value = false;
  if (img) imageAspect.value = 16 / 9;
  clearMarks();
  void nextTick(sizeInk);
});

// ACT: 换文件/收回文件重置字号缩放并清笔迹（标记属于当前展示内容）。
watch(() => props.text, () => {
  zoom.value = 1;
  panX.value = 0;
  panY.value = 0;
  panning.value = false;
  clearMarks();
});

// ── 画笔层（移植自 MeshViewer 的 ink 层）──
type Mark = {
  kind: "arrow" | "rect" | "curve" | "text";
  x0?: number; y0?: number; x1?: number; y1?: number;
  pts?: [number, number][];
  x?: number; y?: number; text?: string; px?: number;
  color: string;
};

// ACT: 与 MeshViewer 相同的 20x20 描边字形，保证四支笔视觉重量一致。
const TOOLS = [
  { id: "arrow", label: "箭头", paths: ["M3 10 H16 M16 10 L11 5.5 M16 10 L11 14.5"] },
  { id: "rect", label: "矩形", paths: ["M4 4 H16 V16 H4 Z"] },
  { id: "curve", label: "自由曲线", paths: ["M3 13 C6 3, 8 17, 11 9 C13 4, 15 6, 17 8"] },
  { id: "text", label: "文字", paths: ["M5 5 H15 M10 5 V16"] },
] as const;

const GLYPHS = {
  clear: ["M4.5 6.5 H15.5", "M8 6.5 V4.5 H12 V6.5", "M6.5 6.5 L7.5 16 H12.5 L13.5 6.5"],
  escape: ["M6 6 L14 14", "M14 6 L6 14"],
  camera: ["M4 7.5 H7 L8.5 5.5 H11.5 L13 7.5 H16 V15 H4 Z", "M10 12.6 m-2.1 0 a2.1 2.1 0 1 0 4.2 0 a2.1 2.1 0 1 0 -4.2 0"],
  download: ["M10 4 V11.5", "M6.5 8.5 L10 12 L13.5 8.5", "M4.5 16 H15.5"],
} as const;

const boxRef = ref<HTMLElement>();
const imageEl = ref<HTMLImageElement>();
const textRef = ref<HTMLElement>();
const inkRef = ref<HTMLCanvasElement>();
const textInput = ref<HTMLInputElement>();
const tool = ref<"" | "arrow" | "rect" | "curve" | "text">("");
// ACT: 默认墨色为海军蓝（navy #000080）：鲜红与主题蓝都偏刺眼，深色蓝更沉稳。
const inkColor = ref("#000080");
const marks = ref<Mark[]>([]);
let draft: Mark | null = null;
const textAt = ref<{ x: number; y: number } | null>(null);
const textDraft = ref("");
// ACT: 文字笔字号：预设档位步进；草稿输入框与落笔墨迹共用同一字号，所见即所得。
const TEXT_PX_STEPS = [12, 14, 16, 20, 24, 32, 40, 56];
const textPx = ref(14);
function stepTextPx(delta: number) {
  const index = TEXT_PX_STEPS.indexOf(textPx.value);
  const next = Math.min(TEXT_PX_STEPS.length - 1, Math.max(0, (index < 0 ? 1 : index) + delta));
  textPx.value = TEXT_PX_STEPS[next];
}

function sizeInk() {
  const canvas = inkRef.value;
  const box = boxRef.value;
  if (!canvas || !box) return;
  const dpr = window.devicePixelRatio || 1;
  const width = box.clientWidth;
  const height = box.clientHeight;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  redrawInk();
}

function drawMark(ctx: CanvasRenderingContext2D, mark: Mark, width: number, height: number) {
  ctx.strokeStyle = mark.color;
  ctx.fillStyle = mark.color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (mark.kind === "arrow") {
    const x0 = (mark.x0 ?? 0) * width, y0 = (mark.y0 ?? 0) * height;
    const x1 = (mark.x1 ?? 0) * width, y1 = (mark.y1 ?? 0) * height;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const angle = Math.atan2(y1 - y0, x1 - x0);
    const head = 12;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(angle - 0.42), y1 - head * Math.sin(angle - 0.42));
    ctx.lineTo(x1 - head * Math.cos(angle + 0.42), y1 - head * Math.sin(angle + 0.42));
    ctx.closePath(); ctx.fill();
  } else if (mark.kind === "rect") {
    ctx.strokeRect(
      Math.min(mark.x0 ?? 0, mark.x1 ?? 0) * width, Math.min(mark.y0 ?? 0, mark.y1 ?? 0) * height,
      Math.abs((mark.x1 ?? 0) - (mark.x0 ?? 0)) * width, Math.abs((mark.y1 ?? 0) - (mark.y0 ?? 0)) * height,
    );
  } else if (mark.kind === "curve") {
    const pts = mark.pts ?? [];
    if (pts.length < 2) return;
    ctx.beginPath();
    pts.forEach(([px, py], index) => (index ? ctx.lineTo(px * width, py * height) : ctx.moveTo(px * width, py * height)));
    ctx.stroke();
  } else if (mark.kind === "text") {
    ctx.font = `${mark.px ?? 14}px ui-monospace, monospace`;
    ctx.textBaseline = "top";
    ctx.fillText(mark.text ?? "", (mark.x ?? 0) * width, (mark.y ?? 0) * height);
  }
}

function redrawInk() {
  const canvas = inkRef.value;
  const ctx = canvas ? canvas.getContext("2d") : null;
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  for (const mark of marks.value) drawMark(ctx, mark, width, height);
  if (draft) drawMark(ctx, draft, width, height);
}

function inkPos(event: PointerEvent) {
  const rect = inkRef.value!.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
    cx: event.clientX - rect.left,
    cy: event.clientY - rect.top,
  };
}

function inkDown(event: PointerEvent) {
  if (!tool.value) return;
  event.preventDefault();
  const point = inkPos(event);
  if (tool.value === "text") {
    textAt.value = { x: point.cx, y: point.cy };
    textDraft.value = "";
    void nextTick(() => textInput.value?.focus());
    return;
  }
  draft = tool.value === "curve"
    ? { kind: "curve", pts: [[point.x, point.y]], color: inkColor.value }
    : { kind: tool.value, x0: point.x, y0: point.y, x1: point.x, y1: point.y, color: inkColor.value };
  inkRef.value?.setPointerCapture?.(event.pointerId);
  redrawInk();
}

function inkMove(event: PointerEvent) {
  if (!draft) return;
  const point = inkPos(event);
  if (draft.kind === "curve") draft.pts?.push([point.x, point.y]);
  else { draft.x1 = point.x; draft.y1 = point.y; }
  redrawInk();
}

function inkUp() {
  if (!draft) return;
  const mark = draft;
  draft = null;
  // ACT: 几乎没移动的点击视为手滑，不落笔（与 MeshViewer 一致）。
  const real = mark.kind === "curve" ? (mark.pts?.length ?? 0) > 2 : Math.hypot((mark.x1 ?? 0) - (mark.x0 ?? 0), (mark.y1 ?? 0) - (mark.y0 ?? 0)) > 0.01;
  if (real) marks.value = [...marks.value, mark];
  redrawInk();
}

function commitText() {
  const at = textAt.value;
  const text = textDraft.value.trim();
  textAt.value = null;
  textDraft.value = "";
  if (!at || !text || !inkRef.value) return;
  const rect = inkRef.value.getBoundingClientRect();
  marks.value = [...marks.value, { kind: "text", x: at.x / rect.width, y: at.y / rect.height, text, px: textPx.value, color: inkColor.value }];
  redrawInk();
}

function toggleTool(id: typeof tool.value) {
  tool.value = tool.value === id ? "" : id;
  draft = null;
  textAt.value = null;
  redrawInk();
}

function disarm() {
  tool.value = "";
  draft = null;
  textAt.value = null;
  redrawInk();
}

// ACT: 窗口级 Esc：与 MeshViewer 相同的双保险——未持笔时 Esc 归别人，焦点在文字草稿框时由框自己处理。
function onEsc(event: KeyboardEvent) {
  if (event.key !== "Escape" || !tool.value) return;
  if (event.target === textInput.value) return;
  disarm();
}

function clearMarks() {
  marks.value = [];
  draft = null;
  redrawInk();
}

// ── 截图：视频帧 + 画笔层合成 PNG ──
const busy = ref(false);

// ACT: 文本模式可截图性：HTML 形态是 sandbox iframe，html2canvas 拿不到 iframe 内容，截图/下载禁用；其余形态所见即所得。
const textCapturable = computed(() => !!props.text && props.text.kind !== "html");

async function capture(): Promise<{ blob: Blob; width: number; height: number } | null> {
  const ink = inkRef.value;
  // ACT: 文本模式截图：光栅化阅读面（含当前滚动窗口与字号），再把屏幕空间笔层 1:1 合上。
  if (props.text) {
    const node = textRef.value;
    if (!node || !textCapturable.value) return null;
    const canvas = await html2canvas(node, {
      backgroundColor: getComputedStyle(node).backgroundColor,
      scale: window.devicePixelRatio || 1,
      logging: false,
    });
    if (ink && marks.value.length) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.drawImage(ink, 0, 0, ink.width, ink.height, 0, 0, canvas.width, canvas.height);
    }
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    return blob ? { blob, width: canvas.width, height: canvas.height } : null;
  }
  // ACT: 图片模式截图：按图片原生尺寸导出，笔层按当前缩放/平移反投影合成（屏幕空间笔迹映回原图画布）。
  const imgEl = imageEl.value;
  if (imgEl && props.image && imgEl.naturalWidth && imgEl.naturalHeight) {
    const box = boxRef.value;
    if (!box) return null;
    const nw = imgEl.naturalWidth;
    const nh = imgEl.naturalHeight;
    const W = box.clientWidth;
    const H = box.clientHeight;
    const out = document.createElement("canvas");
    out.width = nw;
    out.height = nh;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(imgEl, 0, 0, nw, nh);
    if (ink && marks.value.length && W && H) {
      const dpr = window.devicePixelRatio || 1;
      // ACT: 图片显示区（窗中心+平移、窗尺寸×zoom）映射到 ink 画布的设备像素源矩形，越窗部分裁掉。
      const sx = (W / 2 + panX.value - (W * zoom.value) / 2) * dpr;
      const sy = (H / 2 + panY.value - (H * zoom.value) / 2) * dpr;
      const sw = W * zoom.value * dpr;
      const sh = H * zoom.value * dpr;
      const ix0 = Math.max(0, sx);
      const iy0 = Math.max(0, sy);
      const ix1 = Math.min(ink.width, sx + sw);
      const iy1 = Math.min(ink.height, sy + sh);
      if (ix1 > ix0 && iy1 > iy0) {
        const dx0 = ((ix0 - sx) / sw) * nw;
        const dy0 = ((iy0 - sy) / sh) * nh;
        ctx.drawImage(ink, ix0, iy0, ix1 - ix0, iy1 - iy0, dx0, dy0, ((ix1 - ix0) / sw) * nw, ((iy1 - iy0) / sh) * nh);
      }
    }
    const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, "image/png"));
    return blob ? { blob, width: nw, height: nh } : null;
  }
  const video = videoRef.value;
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  const out = document.createElement("canvas");
  out.width = video.videoWidth;
  out.height = video.videoHeight;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, out.width, out.height);
  // ACT: 画笔层与视频内容盒完全重合（stageBox 按视频宽高比撑开），整幅缩放合成即可。
  if (ink && marks.value.length) ctx.drawImage(ink, 0, 0, out.width, out.height);
  const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, "image/png"));
  return blob ? { blob, width: out.width, height: out.height } : null;
}

async function screenshot() {
  if (busy.value) return;
  const shot = await capture();
  if (!shot) return;
  busy.value = true;
  try {
    const name = `vidsay-frame-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    await sendImage(new File([shot.blob], name, { type: "image/png" }), name, shot.width, shot.height);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : translate("上传失败，请稍后重试"));
  } finally {
    busy.value = false;
  }
}

async function download() {
  const shot = await capture();
  if (!shot) return;
  const url = URL.createObjectURL(shot.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `vidsay-frame-${Date.now()}.png`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

let boxObserver: ResizeObserver | null = null;
onMounted(() => {
  window.addEventListener("keydown", onEsc);
  if (typeof ResizeObserver !== "undefined" && boxRef.value) {
    // ACT: 盒子尺寸变化：笔层重测；图片模式还要重算基准缩放（未手动缩放时跟随原生尺寸 fitting）。
    boxObserver = new ResizeObserver(() => {
      sizeInk();
      if (props.image) applyFit();
    });
    boxObserver.observe(boxRef.value);
  }
  sizeInk();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onEsc);
  boxObserver?.disconnect();
  boxObserver = null;
});
</script>

<template>
  <section class="stage">
    <div class="stageBoxWrap">
      <!-- ACT: 盒子按视频原生宽高比撑开（object-fit 无需 letterbox），画笔层与视频内容完全重合。 -->
      <!-- ACT: 无视频时不锁宽高比：占位盒高度随空态内容撑开，胶片图与文案完整可见不被裁切。 -->
      <div ref="boxRef" class="stageBox" :class="{ empty: !current && !image && !text, imageMode: !!image, textMode: !!text }" :style="boxStyle">
        <!-- ACT: 图片模式：与视频同盒同位；transform 先平移后缩放，zoom>1 时指针拖拽平移。 -->
        <img
          v-if="image"
          ref="imageEl"
          class="stageImage"
          :class="{ pannable: zoom > 1, panning }"
          :src="image.url"
          :alt="image.name"
          :style="{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})` }"
          @load="onImageLoad"
          @pointerdown="panDown"
          @pointermove="panMove"
          @pointerup="panUp"
          @pointercancel="panUp" />
        <!-- ACT: 文本模式：只读展示附件内容（纯文本/JSON/Markdown/HTML），字号随 zoom 缩放，不提供编辑入口。 -->
        <div v-else-if="text" ref="textRef" class="stageText" :class="{ framed: text.kind === 'html' }" :style="{ fontSize: `${14 * zoom}px` }">
          <iframe v-if="text.kind === 'html'" class="htmlFrame" sandbox="" :srcdoc="htmlDoc" :title="text.name"></iframe>
          <div v-else-if="text.kind === 'markdown'" class="markdownBody" v-html="markdownHtml"></div>
          <pre v-else class="textContent">{{ text.kind === 'json' ? jsonText : text.content }}</pre>
        </div>
        <video
          v-else-if="current"
          ref="videoRef"
          :src="current.url"
          preload="metadata"
          @loadedmetadata="onMeta"
          @timeupdate="onTime"
          @play="playing = true"
          @pause="playing = false"
          @ended="playing = false" />
        <el-empty v-else :description="translate('该群聊还没有视频')">
          <template #image>
            <!-- ACT: 胶片空态图：mask 渲染 SVG 并以分隔线同色着色；宽 160px 不变，高按固有比例撑开不裁切。 -->
            <span class="filmPic" :style="{ '--tool-icon': `url(&quot;${iconEmptyFilm}&quot;)` }" aria-hidden="true" />
          </template>
        </el-empty>
        <canvas
          ref="inkRef"
          class="ink"
          :style="{ pointerEvents: tool ? 'auto' : 'none' }"
          @pointerdown="inkDown"
          @pointermove="inkMove"
          @pointerup="inkUp" />
        <input
          v-if="textAt"
          ref="textInput"
          v-model="textDraft"
          class="inkText"
          :style="{ left: `${textAt.x}px`, top: `${textAt.y}px`, color: inkColor, fontSize: `${textPx}px` }"
          :placeholder="translate('输入文字，Enter 落笔，Esc 取消')"
          @keydown.enter.prevent="commitText"
          @keydown.escape.prevent="textAt = null"
          @blur="commitText" />
      </div>
    </div>

    <!-- ACT: 控制条：图片模式只留缩小/放大（替换播放/暂停、滑杆与时间盒）且居中；视频模式保持原三件套。 -->
    <div class="stageControls" :class="{ centered: !!image || !!text }">
      <template v-if="image || text">
        <button
          class="ctlButton"
          type="button"
          :disabled="text ? zoom <= TEXT_ZOOM_MIN : zoom <= zoomMin"
          :aria-label="translate('缩小')"
          :title="translate('缩小')"
          @click="zoomBy(1 / ZOOM_STEP)">
          <span class="pic" :style="{ '--tool-icon': `url(&quot;${iconZoomOut}&quot;)` }" aria-hidden="true" />
        </button>
        <button
          class="ctlButton"
          type="button"
          :disabled="text ? zoom >= TEXT_ZOOM_MAX : zoom >= zoomMax"
          :aria-label="translate('放大')"
          :title="translate('放大')"
          @click="zoomBy(ZOOM_STEP)">
          <span class="pic" :style="{ '--tool-icon': `url(&quot;${iconZoomIn}&quot;)` }" aria-hidden="true" />
        </button>
      </template>
      <template v-else>
        <button
          class="ctlButton"
          type="button"
          :disabled="!current"
          :aria-label="playing ? translate('暂停') : translate('播放')"
          :title="playing ? translate('暂停') : translate('播放')"
          @click="togglePlay">
          <span class="pic" :style="{ '--tool-icon': `url(&quot;${playing ? iconVideoPause : iconVideoPlay}&quot;)` }" aria-hidden="true" />
        </button>
        <input
          class="scrubber"
          type="range"
          min="0"
          :max="duration || 0"
          step="0.1"
          :value="sliding ? scrub : currentTime"
          :disabled="!duration"
          :aria-label="translate('滑动定位')"
          @pointerdown="onScrubDown"
          @pointerup="onScrubUp"
          @input="onScrubInput" />
        <span class="timeBox">{{ sliding ? fmt(scrub) : `${fmt(currentTime)} / ${fmt(duration)}` }}</span>
      </template>
    </div>

    <!-- ACT: 画笔工具箱：四支笔 + 墨色 + 清除/放下 + 截图发送/下载；三种模式都在底行第二行居中展示。 -->
    <div class="pens">
      <button
        v-for="item in TOOLS"
        :key="item.id"
        type="button"
        class="penButton"
        :class="{ on: tool === item.id }"
        :title="translate(item.label)"
        :aria-label="translate(item.label)"
        @click="toggleTool(item.id)">
        <svg class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(path, index) in item.paths" :key="index" :d="path" />
        </svg>
      </button>
      <!-- ACT: 字号步进器：仅持文字笔时展示；减/加在预设档位间移动，中间标签显示当前像素值。 -->
      <span v-if="tool === 'text'" class="pxGroup">
        <button
          type="button"
          class="penButton"
          :disabled="textPx <= TEXT_PX_STEPS[0]"
          :title="translate('缩小字号')"
          :aria-label="translate('缩小字号')"
          @click="stepTextPx(-1)">
          <svg class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 10h10" />
          </svg>
        </button>
        <span class="pxLabel">{{ textPx }}px</span>
        <button
          type="button"
          class="penButton"
          :disabled="textPx >= TEXT_PX_STEPS[TEXT_PX_STEPS.length - 1]"
          :title="translate('放大字号')"
          :aria-label="translate('放大字号')"
          @click="stepTextPx(1)">
          <svg class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 10h10" />
            <path d="M10 5v10" />
          </svg>
        </button>
      </span>
      <input v-model="inkColor" type="color" :title="translate('墨色')" :aria-label="translate('墨色')" />
      <span class="sep" aria-hidden="true" />
      <button
        type="button"
        class="penButton"
        :disabled="!marks.length"
        :title="translate('清除标记')"
        :aria-label="translate('清除标记')"
        @click="clearMarks">
        <svg class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(path, index) in GLYPHS.clear" :key="index" :d="path" />
        </svg>
      </button>
      <button
        type="button"
        class="penButton"
        :class="{ on: !!tool }"
        :disabled="!tool"
        :title="translate('放下画笔')"
        :aria-label="translate('放下画笔')"
        @click="disarm">
        <svg class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(path, index) in GLYPHS.escape" :key="index" :d="path" />
        </svg>
      </button>
      <span class="sep" aria-hidden="true" />
      <button
        type="button"
        class="penButton"
        :disabled="(!current && !image && !textCapturable) || busy || !ready || !activeRoomId"
        :title="translate('截图并发送到群聊')"
        :aria-label="translate('截图并发送到群聊')"
        @click="screenshot">
        <svg class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(path, index) in GLYPHS.camera" :key="index" :d="path" />
        </svg>
      </button>
      <button
        type="button"
        class="penButton"
        :disabled="!current && !image && !textCapturable"
        :title="translate('下载截图')"
        :aria-label="translate('下载截图')"
        @click="download">
        <svg class="pic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-for="(path, index) in GLYPHS.download" :key="index" :d="path" />
        </svg>
      </button>
    </div>
  </section>
</template>

<style lang="scss" scoped>
// ACT: 背景对齐 Studio 画布：同底色 + 16px 点阵（Vue Flow Background 的 CSS 复现）。
.stage {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background-color: var(--el-bg-color);
  background-image: radial-gradient(var(--el-border-color) 1px, transparent 1px);
  background-size: 16px 16px;
}

.stageBoxWrap {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 16px;
}

.stageBox {
  position: relative;
  max-width: 100%;
  max-height: 100%;
  overflow: hidden;
  border-radius: var(--ui-radius);
  background: #000;

  // ACT: 无视频时的占位态：透明底且无边框（原虚线框按需求移除，空态只留胶片图与文案），空态文案居中于盒内。
  &.empty {
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
  }

  // ACT: 图片模式的最大显示窗「隐形」：不画黑底、不画边框，只看见图片本身；
  // 图片小于最大窗时按原生尺寸居中，周围露出舞台点阵背景而非黑块。
  &.imageMode {
    background: transparent;
  }

  // ACT: 文本模式阅读面：撑满可用区域、实底遮住点阵、内部滚动；同样不画黑底与边框。
  &.textMode {
    width: 100%;
    height: 100%;
    background: var(--el-bg-color);
  }

  :deep(.el-empty) { padding: 24px 0; }

  // ACT: 胶片空态图字形：mask + currentColor 同款技法，颜色取竖直分隔线同色 --el-border-color；
  // 宽度撑满 .el-empty__image 的 160px，高度按 SVG 固有比例（1392/1024）展开，整图可见。
  .filmPic {
    display: block;
    width: 100%;
    aspect-ratio: 1392 / 1024;
    background-color: var(--el-border-color);
    mask-image: var(--tool-icon);
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
    -webkit-mask-image: var(--tool-icon);
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-position: center;
    -webkit-mask-size: contain;
  }

  video {
    display: block;
    width: 100%;
    height: 100%;
  }

  // ACT: 图片模式：填满内容盒（盒子已按图片原生比例撑开，contain 即满幅）；
  // 禁原生拖图与选中，缩放平移全走 transform；zoom>1 时抓手光标提示可拖。
  .stageImage {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    touch-action: none;
    user-select: none;
    -webkit-user-drag: none;

    &.pannable { cursor: grab; }
    &.panning { cursor: grabbing; }
  }

  // ACT: 文本容器：内滚 + 内边距；HTML 形态由 iframe 自滚，去掉内边距贴边。
  .stageText {
    width: 100%;
    height: 100%;
    padding: 16px 20px;
    overflow: auto;

    &.framed { padding: 0; }
  }

  .textContent {
    margin: 0;
    font-family: ui-monospace, monospace;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }

  .htmlFrame {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: #fff;
  }

  // ACT: Markdown 排版：标题/代码块/引用/表格/链接取主题变量，字号继承容器（随缩放）。
  .markdownBody {
    line-height: 1.7;
    overflow-wrap: break-word;

    :deep(h1), :deep(h2), :deep(h3), :deep(h4), :deep(h5), :deep(h6) { margin: 12px 0 8px; font-weight: 600; }
    :deep(h1) { font-size: 1.6em; }
    :deep(h2) { font-size: 1.4em; }
    :deep(h3) { font-size: 1.2em; }
    :deep(pre) { padding: 10px 12px; border-radius: 8px; background: var(--el-fill-color-light); overflow: auto; }
    :deep(code) { font-family: ui-monospace, monospace; font-size: 0.9em; }
    :deep(blockquote) { margin: 8px 0; padding: 4px 12px; border-left: 3px solid var(--el-border-color); color: var(--el-text-color-regular); }
    :deep(table) { border-collapse: collapse; }
    :deep(th), :deep(td) { padding: 4px 10px; border: 1px solid var(--el-border-color); }
    :deep(a) { color: var(--el-color-primary); }
    :deep(img) { max-width: 100%; }
  }

  .ink {
    position: absolute;
    inset: 0;
    touch-action: none;
  }

  .inkText {
    position: absolute;
    z-index: 2;
    padding: 2px 6px;
    border: 1px dashed currentColor;
    border-radius: 4px;
    background: color-mix(in srgb, var(--el-bg-color) 82%, transparent);
    // ACT: 字号由内联样式按 textPx 注入，这里只定字体族。
    font-family: ui-monospace, monospace;
    outline: none;
  }
}

.stageControls {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px 10px;

  // ACT: 图片模式：缩小/放大两键居于底行水平中间。
  &.centered {
    justify-content: center;
  }

  .ctlButton {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    // ACT: 边框用较浅的 --el-border-color，与聊天框 Generate 按钮边框同色；图标用 primary 文字色，与聊天框图标同深度；禁用态仅换光标。
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
    background: transparent;
    color: var(--el-text-color-primary);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;

    &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
    &:disabled { cursor: not-allowed; }

    // ACT: 播放/暂停字形为 src/icons 的 1.9 描边 SVG，mask + currentColor 着色，与画笔/聊天框图标同色。
    .pic {
      background-color: currentColor;
      mask-image: var(--tool-icon);
      mask-repeat: no-repeat;
      mask-position: center;
      mask-size: contain;
      -webkit-mask-image: var(--tool-icon);
      -webkit-mask-repeat: no-repeat;
      -webkit-mask-position: center;
      -webkit-mask-size: contain;
    }
  }

  // ACT: 滑杆轨道与滑块同图标色（regular 文字色），不再使用系统默认浅灰轨道；禁用态不降透明度。
  .scrubber {
    flex: 1;
    min-width: 0;
    height: 12px;
    margin: 0;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
    outline: none;
    cursor: pointer;

    &::-webkit-slider-runnable-track {
      height: 4px;
      border-radius: 2px;
      background: var(--el-text-color-regular);
    }

    &::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 12px;
      height: 12px;
      margin-top: -4px;
      border-radius: 50%;
      background: var(--el-text-color-regular);
      cursor: pointer;
    }

    &::-moz-range-track {
      height: 4px;
      border-radius: 2px;
      background: var(--el-text-color-regular);
    }

    &::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border: 0;
      border-radius: 50%;
      background: var(--el-text-color-regular);
      cursor: pointer;
    }

    &:disabled { cursor: not-allowed; }
  }

  // ACT: 时间盒：滑动时显示滑杆目标时间，平时显示 当前/总长。
  .timeBox {
    flex-shrink: 0;
    min-width: 92px;
    padding: 3px 8px;
    // ACT: 边框用 --el-border-color，与播放按钮/画笔/聊天框各图标按钮边框同色。
    border: 1px solid var(--el-border-color);
    border-radius: 6px;
    background: var(--el-fill-color-light);
    color: var(--el-text-color-regular);
    font: 12px ui-monospace, monospace;
    text-align: center;
  }
}

.pens {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 16px 14px;

  // ACT: 字号步进器：与笔按钮同高的紧凑三段（减/标签/加），仅持文字笔时挂载。
  .pxGroup {
    display: inline-flex;
    align-items: center;
    gap: 2px;

    .pxLabel {
      min-width: 42px;
      text-align: center;
      font-size: 12px;
      color: var(--el-text-color-regular);
      font-variant-numeric: tabular-nums;
    }
  }

  .penButton {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
    background: transparent;
    color: var(--el-text-color-primary);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;

    &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
    &:disabled { opacity: 0.45; cursor: not-allowed; }
    &.on {
      border-color: var(--el-color-primary);
      background: var(--el-color-primary-light-9);
      color: var(--el-color-primary);
    }
  }

  // ACT: 墨色选择器：外框与笔按钮同为 30×30 盒；内色块缩到 14×14（padding 7px + border-box），
  // 比笔按钮的 18×18 字形再小一圈，实心色块视觉重量才与邻按钮平衡。
  input[type="color"] {
    box-sizing: border-box;
    width: 30px;
    height: 30px;
    padding: 7px;
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
    background: transparent;
    cursor: pointer;

    &::-webkit-color-swatch-wrapper { padding: 0; }
    &::-webkit-color-swatch { border: none; border-radius: 4px; }
    &::-moz-color-swatch { border: none; border-radius: 4px; }
  }

  .sep {
    width: 1px;
    height: 18px;
    margin: 0 4px;
    background: var(--el-border-color);
  }
}

.pic {
  width: 18px;
  height: 18px;
}
</style>
