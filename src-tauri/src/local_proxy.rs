//! 本机 HTTP 代理：把 `media::handle` 的 HLS 代理经 127.0.0.1 以普通 HTTP 暴露给原生播放器。
//!
//! 背景：iOS 17.0 没有 ManagedMediaSource，App 走原生播放器；源站 m3u8 的
//! Content-Type 是 text/plain，原生 AVFoundation 拒收（MediaError code=4）。
//! `media::handle` 本已能以正确类型（application/vnd.apple.mpegurl）重发清单，
//! 但它挂在 hg:// 自定义协议上，原生播放器取不到。于是起一个只监听回环地址的
//! 极简 HTTP 服务，把同一套逻辑以 http://127.0.0.1:PORT/hls?u=… /seg?u=… 暴露出来。
//! 仅放行视频 CDN（hzjvlo.cn / drleao.cn 及其子域），不作通用代理。
//! 不引新依赖：只用已有的 tokio + percent-encoding + url。

use once_cell::sync::Lazy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use std::io::Write as _;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

static SERVER: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

const MAX_HEADER_BYTES: usize = 32 * 1024;

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn dec(s: &str) -> String {
    percent_decode_str(s).decode_utf8_lossy().to_string()
}

/// 只放行视频 CDN，避免本机服务被当成通用代理。
fn allowed_target(raw: &str) -> bool {
    let Ok(u) = url::Url::parse(raw) else {
        return false;
    };
    if u.scheme() != "https" {
        return false;
    }
    let Some(host) = u.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == "hzjvlo.cn"
        || host.ends_with(".hzjvlo.cn")
        || host == "drleao.cn"
        || host.ends_with(".drleao.cn")
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        502 => "Bad Gateway",
        _ => "OK",
    }
}

fn error_response(status: u16) -> Vec<u8> {
    let body = format!("{} {}\n", status, reason(status));
    let mut out = Vec::with_capacity(body.len() + 128);
    let _ = write!(out, "HTTP/1.1 {} {}\r\n", status, reason(status));
    let _ = write!(out, "Content-Type: text/plain\r\n");
    let _ = write!(out, "Content-Length: {}\r\n", body.len());
    let _ = write!(out, "Connection: close\r\n");
    let _ = write!(out, "\r\n");
    out.extend_from_slice(body.as_bytes());
    out
}

/// 解析单段 Range，返回 (start, end_inclusive)；非法或越界返回 None。
fn parse_range(header: &str, len: usize) -> Option<(usize, usize)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    if a.is_empty() {
        // 后缀形式 bytes=-N：取最后 N 字节
        let n: usize = b.trim().parse().ok()?;
        if n == 0 || len == 0 {
            return None;
        }
        let start = len.saturating_sub(n);
        Some((start, len - 1))
    } else {
        let start: usize = a.trim().parse().ok()?;
        if start >= len {
            return None;
        }
        let end = if b.trim().is_empty() {
            len - 1
        } else {
            let e: usize = b.trim().parse().ok()?;
            e.min(len - 1)
        };
        if end < start {
            return None;
        }
        Some((start, end))
    }
}

/// Range 语法合法但起点越界时应回 416；语法本身非法时忽略 Range 回 200。
fn range_out_of_bounds(header: &str, total: usize) -> bool {
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return false;
    };
    let Some((a, _)) = spec.split_once('-') else {
        return false;
    };
    if a.is_empty() {
        return false;
    }
    a.trim().parse::<usize>().map(|s| s >= total).unwrap_or(false)
}

/// 把 media::handle 的响应序列化成原始 HTTP（含单段 Range 支持）。
fn build_response(
    resp: tauri::http::Response<Vec<u8>>,
    range: Option<&str>,
    head_only: bool,
) -> Vec<u8> {
    let (parts, body) = resp.into_parts();
    let total = body.len();
    let mut status = parts.status.as_u16();
    let mut content_range: Option<String> = None;
    let mut slice: &[u8] = &body;
    if let Some(r) = range {
        if let Some((start, end)) = parse_range(r, total) {
            status = 206;
            content_range = Some(format!("bytes {start}-{end}/{total}"));
            slice = &body[start..=end];
        } else if range_out_of_bounds(r, total) {
            status = 416;
            content_range = Some(format!("bytes */{total}"));
            slice = &[];
        }
    }
    let mut out = Vec::with_capacity(slice.len() + 512);
    let _ = write!(out, "HTTP/1.1 {} {}\r\n", status, reason(status));
    for (name, value) in parts.headers.iter() {
        let lname = name.as_str().to_ascii_lowercase();
        if lname == "content-length" || lname == "connection" || lname == "content-range" {
            continue;
        }
        let _ = write!(
            out,
            "{}: {}\r\n",
            name.as_str(),
            String::from_utf8_lossy(value.as_bytes())
        );
    }
    if let Some(cr) = &content_range {
        let _ = write!(out, "Content-Range: {cr}\r\n");
    }
    let _ = write!(out, "Content-Length: {}\r\n", slice.len());
    let _ = write!(out, "Connection: close\r\n");
    let _ = write!(out, "Access-Control-Allow-Origin: *\r\n");
    let _ = write!(out, "\r\n");
    if !head_only {
        out.extend_from_slice(slice);
    }
    out
}

/// 读请求行 + 请求头，调 media::handle，返回完整 HTTP 响应字节。
async fn serve(reader: &mut BufReader<TcpStream>, origin: &str) -> Vec<u8> {
    let mut request_line = String::new();
    match reader.read_line(&mut request_line).await {
        Ok(0) | Err(_) => return error_response(400),
        Ok(n) if n > MAX_HEADER_BYTES => return error_response(400),
        Ok(_) => {}
    }
    let mut it = request_line.split_whitespace();
    let method = it.next().unwrap_or("").to_string();
    let mut target = it.next().unwrap_or("").to_string();
    if method.is_empty() || target.is_empty() {
        return error_response(400);
    }
    // 兼容 absolute-form：http://127.0.0.1:PORT/hls?u=…
    if let Some(rest) = target.strip_prefix("http://") {
        target = match rest.find('/') {
            Some(i) => rest[i..].to_string(),
            None => "/".to_string(),
        };
    }
    let mut range: Option<String> = None;
    let mut total = request_line.len();
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => return error_response(400),
            Ok(n) => {
                total += n;
                if total > MAX_HEADER_BYTES {
                    return error_response(400);
                }
            }
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.trim().eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_string());
            }
        }
    }
    if method != "GET" && method != "HEAD" {
        return error_response(405);
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };
    if path != "/hls" && path != "/seg" {
        return error_response(404);
    }
    let target_url = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("u="))
        .map(dec)
        .unwrap_or_default();
    if !allowed_target(&target_url) {
        return error_response(403);
    }
    let resp = crate::media::handle(&path, &query, origin).await;
    build_response(resp, range.as_deref(), method == "HEAD")
}

async fn handle_conn(stream: TcpStream, origin: String) {
    let mut reader = BufReader::new(stream);
    let response = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        serve(&mut reader, &origin),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => error_response(400),
    };
    let mut stream = reader.into_inner();
    let _ = stream.write_all(&response).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

async fn run_server(listener: TcpListener, origin: String) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let origin = origin.clone();
                tauri::async_runtime::spawn(async move {
                    handle_conn(stream, origin).await;
                });
            }
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    }
}

/// 首次调用时启动本机服务并返回基址（http://127.0.0.1:PORT），之后复用。
async fn ensure_origin() -> Result<String, String> {
    let mut guard = SERVER.lock().await;
    if let Some(origin) = guard.as_ref() {
        return Ok(origin.clone());
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("本地代理启动失败: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("本地代理取端口失败: {e}"))?
        .port();
    let origin = format!("http://127.0.0.1:{port}");
    let origin_for_task = origin.clone();
    tauri::async_runtime::spawn(async move {
        run_server(listener, origin_for_task).await;
    });
    *guard = Some(origin.clone());
    Ok(origin)
}

/// 取本机 HTTP 代理的播放清单地址（原生播放器用）。
#[tauri::command]
pub async fn proxy_play_url(src: String) -> Result<String, String> {
    if !(src.starts_with("http://") || src.starts_with("https://")) {
        return Err("只支持 http(s) 播放地址".into());
    }
    let origin = ensure_origin().await?;
    Ok(format!("{origin}/hls?u={}", enc(&src)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=-200", 1000), Some((800, 999)));
        assert_eq!(parse_range("bytes=0-9999", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=abc-", 1000), None);
        assert!(range_out_of_bounds("bytes=1000-", 1000));
        assert!(!range_out_of_bounds("bytes=abc-", 1000));
        assert!(!range_out_of_bounds("bytes=-200", 1000));
    }

    #[test]
    fn target_allowlist() {
        assert!(allowed_target(
            "https://yd-lphu-long.hzjvlo.cn/videos5/a/a.m3u8?auth_key=1"
        ));
        assert!(allowed_target(
            "https://tp2.drleao.cn/videos5/a/crypt.key?auth_key=1"
        ));
        assert!(!allowed_target("https://evil.example/a.m3u8"));
        assert!(!allowed_target("http://hzjvlo.cn/a.m3u8"));
    }
}
