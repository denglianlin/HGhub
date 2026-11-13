import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type Hls from "hls.js";

/** Keep asynchronous autoplay and error recovery subject to the latest page activity. */
export function usePlaybackActivity(
  videoRef: RefObject<HTMLVideoElement | null>, hlsRef: RefObject<Hls | null>,
  { active, autoPlay, src, trace, onPlayRejected }: { active: boolean; autoPlay: boolean; src: string; trace: (event: string, data?: Record<string, unknown>) => void; onPlayRejected?: (source: string, errorName: string) => void },
) {
  const latest = useRef({ active, trace }); latest.current = { active, trace };
  const rejectedRef = useRef(onPlayRejected); rejectedRef.current = onPlayRejected;
  const wanted = useRef(autoPlay);
  const mounted = useRef(true);
  const previous = useRef(active);
  useLayoutEffect(() => { wanted.current = autoPlay; }, [src, autoPlay]);

  const play = useCallback((source: string, automatic = false) => {
    const v = videoRef.current;
    if (!v) return;
    if (!mounted.current || !latest.current.active || (automatic && !wanted.current)) {
      latest.current.trace("play.blocked", { source, inactive: !latest.current.active, play_wanted: wanted.current });
      return;
    }
    wanted.current = true;
    const hls = hlsRef.current;
    if (hls?.levels.length && !hls.loadingEnabled) hls.startLoad(v.currentTime);
    latest.current.trace("play.request", { source });
    v.play().then(() => {
      // The page may have changed while play() was pending.
      if (!mounted.current || !latest.current.active) v.pause();
    }).catch(e => {
      latest.current.trace("play.rejected", { source, error_name: e?.name });
      // 诊断用：只把用户手动触发的 play() 拒绝显示出来，自动播放被拒是常见情况、不弹。
      if (!automatic) rejectedRef.current?.(source, e?.name ?? "unknown");
    });
  }, []);
  const pause = useCallback((source = "handle") => {
    wanted.current = false;
    latest.current.trace("pause.request", { source });
    videoRef.current?.pause();
  }, []);

  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    mounted.current = true;
    const hls = hlsRef.current;
    if (!active) {
      // Include pauses made through native/PiP controls, which bypass our buttons.
      if (v.readyState >= 2) wanted.current = !v.paused;
      v.pause();
      // Let an in-flight manifest finish, but stop fragment loading for hidden pages.
      if (hls?.levels.length) hls.stopLoad();
      latest.current.trace("page.suspended", { play_wanted: wanted.current });
    } else if (!previous.current) {
      if (hls?.levels.length && !hls.loadingEnabled) hls.startLoad(v.currentTime);
      if (wanted.current && (hls?.levels.length || v.readyState > 0)) play("page_active", true);
    }
    previous.current = active;
  }, [active, play]);

  useLayoutEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const guard = () => {
      if (latest.current.active) return;
      latest.current.trace("play.blocked", { source: "media_event", inactive: true });
      v.pause();
      if (hlsRef.current?.levels.length) hlsRef.current.stopLoad();
    };
    v.addEventListener("play", guard);
    v.addEventListener("playing", guard);
    return () => { mounted.current = false; v.removeEventListener("play", guard); v.removeEventListener("playing", guard); v.pause(); };
  }, []);
  return { play, pause, isActive: () => mounted.current && latest.current.active };
}
