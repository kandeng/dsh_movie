// ACT: Matrix「鉴权媒体」公共辅助。Synapse 1.157 起默认的 /_matrix/media/v3/download 已关闭，
// 媒体必须走 /_matrix/client/v1/media/download/<serverName>/<mediaId> 并携带 Bearer 令牌；
// 而 <img>/<video> 的 src 无法附带请求头，因此统一用令牌把媒体拉成 blob 再交给 objectURL。
// 独立成模块是为了让 auth store（头像）与 useMatrixChat（消息媒体）共用，且两者互不依赖。

// 由 mxc://<serverName>/<mediaId> 构造同源鉴权下载地址（经 Vite /_matrix 代理转发到 Synapse）。
export function authenticatedMediaUrl(mxc: string): string {
  if (typeof mxc !== "string" || !mxc.startsWith("mxc://")) return "";
  const body = mxc.slice("mxc://".length);
  const slash = body.indexOf("/");
  if (slash <= 0) return "";
  const serverName = body.slice(0, slash);
  const mediaId = body.slice(slash + 1);
  if (!serverName || !mediaId) return "";
  return `${window.location.origin}/_matrix/client/v1/media/download/${serverName}/${mediaId}`;
}

// 用访问令牌把 mxc 媒体下载为 blob 并返回 objectURL；调用方负责在不再需要时 revoke。
export async function fetchMediaBlobUrl(mxc: string, accessToken: string): Promise<string> {
  const url = authenticatedMediaUrl(mxc);
  if (!url || !accessToken) return "";
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`media HTTP ${response.status}`);
  return URL.createObjectURL(await response.blob());
}
