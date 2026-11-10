import React, { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import Hls from "hls.js";
import { isLocalMedia, platform, playlist } from "../api";
import { mediaResource, observeHls, usePlayerDiagnostics } from "../playbackDiagnostics";
import { usePlaybackActivity } from "../usePlaybackActivity";

export type VideoHandle = {
  el: () => HTMLVideoElement | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number, sourceOrAutoResume?: string | boolean) => void;
  trace: (event: string, data?: Record<string, unknown>) => void;
  rate: (r: number) => void;
  mute: (m: boolean) => void;
  volume: (v: number) => void;
  reload: () => void;
};

type Props = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  active?: boolean;
  diagnosticContext?: Record<string, unknown>;
  muted?: boolean;
  loop?: boolean;
  fit?: "contain" | "cover";
  /** 缩放倍率与平移偏移（用于移动端竖屏下双指缩放横屏视频） */
  scale?: number;
  panX?: number;
  panY?: number;
  isGesturing?: boolean;
  /** 换源后重新套用，避免切集时音量/倍速被浏览器重置 */
  volume?: number;
  rate?: number;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  onSize?: (w: number, h: number) => void;
  onPlaying?: () => void;
  onPause?: () => void;
  onWaiting?: () => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;
  onClick?: () => void;
  className?: string;
};

/** 只负责「播」：hls.js + video 元素，控制条由外层渲染。 */
const VideoSurface = forwardRef<VideoHandle, Props>(function VideoSurface(
  { src, poster, autoPlay = true, active = true, diagnosticContext = {}, muted = false, loop = false, fit = "contain",
    scale = 1, panX = 0, panY = 0, isGesturing = false,
    volume = 1, rate = 1,
    onTime, onDuration, onSize, onPlaying, onPause, onWaiting, onEnded, onError, onClick, className = "" },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const recoverCountRef = useRef(0);
  const recoverTimerRef = useRef<number | null>(null);
  const lastSizeRef = useRef({ w: 0, h: 0 });
  const [ready, setReady] = useState(false);
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay, src, trace });

  const reportSizeAndDuration = (v: HTMLVideoElement) => {
    if (v.duration && Number.isFinite(v.duration) && v.duration > 0) {
      onDuration?.(v.duration);
    }
    const w = v.videoWidth || 0;
    const h = v.videoHeight || 0;
    if (w > 0 && h > 0 && (w !== lastSizeRef.current.w || h !== lastSizeRef.current.h)) {
      lastSizeRef.current = { w, h };
      onSize?.(w, h);
    }
  };

  const safeSeek = (t: number, sourceOrAutoResume: string | boolean = "handle") => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(t)) return;
    const dur = v.duration && Number.isFinite(v.duration) ? v.duration : 0;
    const target = dur > 0 ? Math.max(0, Math.min(dur - 0.15, t)) : Math.max(0, t);
    const source = typeof sourceOrAutoResume === "string" ? sourceOrAutoResume : "handle";
    const autoResume = typeof sourceOrAutoResume === "boolean" ? sourceOrAutoResume : !v.paused;

    requestSeek(target, source);
    onWaiting?.();
    if (hlsRef.current) {
      try {
        hlsRef.current.startLoad(target);
      } catch { /* ignore */ }
    }

    try {
      v.currentTime = target;
      trace("seek.assigned", { target, source });
    } catch (e) {
      trace("seek.rejected", { error_name: (e as Error).name });
    }

    if (autoResume && activity.isActive()) {
      const resumeOnce = () => {
        v.removeEventListener("seeked", resumeOnce);
        v.removeEventListener("canplay", resumeOnce);
        if (activity.isActive()) v.play().catch(() => {});
      };
      v.addEventListener("seeked", resumeOnce, { once: true });
      v.addEventListener("canplay", resumeOnce, { once: true });
      // 兜底：若 350ms 内已经就绪则直接播
      window.setTimeout(() => {
        if (v.readyState >= 2 && v.paused && activity.isActive()) {
          v.removeEventListener("seeked", resumeOnce);
          v.removeEventListener("canplay", resumeOnce);
          v.play().catch(() => {});
        }
      }, 350);
    }
  };

  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    play: () => activity.play("handle"),
    pause: () => activity.pause(),
    toggle: () => {
      const v = videoRef.current;
      if (!v) return;
      trace("toggle.request");
      if (v.paused) activity.play("toggle"); else activity.pause("toggle");
    },
    seek: (t: number, sourceOrAutoResume: string | boolean = "handle") => safeSeek(t, sourceOrAutoResume),
    trace,
    rate: (r: number) => { const v = videoRef.current; if (v) v.playbackRate = r; },
    mute: (m: boolean) => { const v = videoRef.current; if (v) v.muted = m; },
    volume: (vol: number) => { const v = videoRef.current; if (v) v.volume = vol; },
    reload: () => {
      const v = videoRef.current;
      if (!v) return;
      recoverCountRef.current = 0;
      const cur = v.currentTime || 0;
      if (hlsRef.current) {
        try {
          hlsRef.current.startLoad(cur);
          activity.play("reload");
          return;
        } catch { /* ignore */ }
      }
      v.load();
      if (cur > 0) {
        try { v.currentTime = cur; } catch { /* ignore */ }
      }
      activity.play("reload");
    },
  }));

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setReady(false);
    recoverCountRef.current = 0;
    lastSizeRef.current = { w: 0, h: 0 };
    if (recoverTimerRef.current) {
      window.clearTimeout(recoverTimerRef.current);
      recoverTimerRef.current = null;
    }
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const proxied = isLocalMedia(src);
    const url = proxied ? src : playlist(src);
    const useHls = !url.includes("/seg?u=");
    const isIos = platform === "ios";
    trace("source.load", { engine: useHls && Hls.isSupported() ? "hls.js" : "native", auto_play: autoPlay, resource: mediaResource(src) });

    /* 换源时先把音量/倍速套回去：hls 重新 attach 后浏览器会把它们重置成默认值 */
    const applySettings = () => {
      const v = videoRef.current;
      if (!v) return;
      v.volume = volume;
      v.muted = muted;
      v.playbackRate = rate;
    };
    applySettings();

    if (useHls && Hls.isSupported()) {
      const hls = new Hls({
        // 禁用从插播/内容引导 JSON 派生直连 URL 的可选功能。
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
        // iOS WKWebView 下 WebWorker 跨自定义协议 hg:// 高频中断易死锁，关闭 Worker 走主线程加载更稳
        enableWorker: !isIos,
        // Prefer standard MSE on macOS; hls.js handles MMS-only fallback and seek recovery.
        preferManagedMediaSource: false,
        autoStartLoad: false,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 30,
        maxBufferHole: 0.5,
        highBufferWatchdogPeriod: 2,
        nudgeOffset: 0.25,
        nudgeMaxRetry: 6,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 20000,
        levelLoadingMaxRetry: 4,
        fragLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 400,
        startFragPrefetch: true,
      });
      hlsRef.current = hls;
      observeHls(hls, trace);
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (activity.isActive()) hls.startLoad();
        if (autoPlay) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        recoverCountRef.current = 0;
        setReady(true);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        // 非致命卡顿错误（常见于拖动进度条后缓冲空洞）：主动触发加载与微调跳帧
        if (!data.fatal) {
          if (
            activity.isActive() && (
              data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ||
              data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
              data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT
            )
          ) {
            try {
              hls.startLoad(video.currentTime || -1);
            } catch { /* ignore */ }
          }
          return;
        }

        if (!activity.isActive()) return;

        // 致命错误：优先自动重连/恢复解码器，最多静默恢复 4 次，避免拖动进度条直接弹报错层
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (recoverCountRef.current < 4) {
            recoverCountRef.current += 1;
            const delay = 250 * recoverCountRef.current;
            if (recoverTimerRef.current) window.clearTimeout(recoverTimerRef.current);
            recoverTimerRef.current = window.setTimeout(() => {
              if (!hlsRef.current || !activity.isActive()) return;
              try {
                hlsRef.current.startLoad(video.currentTime || -1);
                if (!video.paused) video.play().catch(() => {});
              } catch { /* ignore */ }
            }, delay);
            return;
          }
          onError?.(`${data.type}/${data.details}`);
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          if (recoverCountRef.current < 4) {
            recoverCountRef.current += 1;
            try {
              if (recoverCountRef.current === 2) hls.swapAudioCodec();
              hls.recoverMediaError();
              video.play().catch(() => {});
            } catch { /* ignore */ }
            return;
          }
          onError?.(`${data.type}/${data.details}`);
          hls.recoverMediaError();
        } else {
          onError?.(`${data.type}/${data.details}`);
          hls.destroy();
          hlsRef.current = null;
        }
      });
    } else {
      video.src = url;
      if (autoPlay) activity.play("native_autoplay", true);
    }

    return () => {
      trace("source.cleanup");
      if (recoverTimerRef.current) {
        window.clearTimeout(recoverTimerRef.current);
        recoverTimerRef.current = null;
      }
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = volume; }, [volume]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate]);

  const reapply = (v: HTMLVideoElement) => {
    v.volume = volume;
    v.muted = muted;
    v.playbackRate = rate;
  };

  const nearEndFiredRef = useRef(false);
  useEffect(() => {
    nearEndFiredRef.current = false;
  }, [src]);

  // Native Resize Event listener for HTMLVideoElement (React doesn't always bind onResize on <video>)
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    const onVideoResize = () => reportSizeAndDuration(v);
    v.addEventListener("resize", onVideoResize);
    return () => v.removeEventListener("resize", onVideoResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const hasTransform = scale !== 1 || panX !== 0 || panY !== 0;

  return (
    <div className={`relative w-full h-full bg-black overflow-hidden ${className}`}>
      {!ready && poster && (
        <img
          src={poster}
          alt=""
          className={`absolute inset-0 w-full h-full pointer-events-none ${fit === "cover" ? "object-cover" : "object-contain"}`}
        />
      )}
      <video
        ref={videoRef}
        playsInline
        webkit-playsinline="true"
        preload="auto"
        muted={muted}
        loop={loop}
        onClick={onClick}
        className={`w-full h-full bg-black ${fit === "cover" ? "object-cover" : "object-contain"}`}
        style={{
          opacity: ready ? 1 : 0,
          transform: hasTransform ? `translate3d(${panX}px, ${panY}px, 0) scale(${scale})` : "translateZ(0)",
          transformOrigin: "center center",
          transition: isGesturing ? "opacity .25s" : "opacity .25s, transform .2s cubic-bezier(.2,0,0,1)",
        }}
        onLoadedData={(e) => {
          const v = e.target as HTMLVideoElement;
          setReady(true);
          reapply(v);
          reportSizeAndDuration(v);
        }}
        onCanPlay={(e) => {
          const v = e.target as HTMLVideoElement;
          setReady(true);
          reportSizeAndDuration(v);
        }}
        onTimeUpdate={(e) => {
          const v = e.target as HTMLVideoElement;
          onTime?.(v.currentTime);
          if (lastSizeRef.current.w === 0 && v.videoWidth > 0) {
            reportSizeAndDuration(v);
          }
          // 借鉴 stclock1988/hghub-ios：部分 HLS 流容器标称时长比最后一个分片略长 0.5~1.2s，
          // 接近片尾时提前复位准备，若卡在片尾则自动触发连播
          if (!loop && !nearEndFiredRef.current && activity.isActive() && v.duration > 5 && v.currentTime >= v.duration - 0.35) {
            nearEndFiredRef.current = true;
            onEnded?.();
          }
        }}
        onLoadedMetadata={(e) => {
          const v = e.target as HTMLVideoElement;
          reapply(v);
          reportSizeAndDuration(v);
        }}
        onPlay={() => { if (activity.isActive()) onPlaying?.(); }}
        onPause={() => onPause?.()}
        onWaiting={(e) => {
          const v = e.target as HTMLVideoElement;
          if (!loop && !nearEndFiredRef.current && activity.isActive() && v.duration > 5 && v.currentTime >= v.duration - 1.5) {
            nearEndFiredRef.current = true;
            onEnded?.();
            return;
          }
          onWaiting?.();
        }}
        onPlaying={(e) => {
          setReady(true);
          recoverCountRef.current = 0;
          reportSizeAndDuration(e.target as HTMLVideoElement);
          if (activity.isActive()) onPlaying?.();
        }}
        onSeeking={() => onWaiting?.()}
        onSeeked={() => {
          const v = videoRef.current;
          if (v && !v.paused && activity.isActive()) onPlaying?.();
        }}
        onEnded={() => {
          if (!nearEndFiredRef.current && activity.isActive()) {
            nearEndFiredRef.current = true;
            onEnded?.();
          }
        }}
      />
    </div>
  );
});

export default VideoSurface;
